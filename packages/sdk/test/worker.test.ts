import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NonRetryableError, createWorker, type TaskContext, type Worker, type WorkerOptions } from "../src/index.js";
import { FakeApi, makeTask, until } from "./fake-api.js";

const KEY = `ffk_AAAAAAAA_${"A".repeat(43)}`;
let api: FakeApi;
let worker: Worker | null;
let logs: { level: string; msg: string; data?: Record<string, unknown> }[];

beforeEach(async () => {
  api = await FakeApi.start();
  worker = null;
  logs = [];
});
afterEach(async () => {
  await worker?.stop();
  await api.close();
});

function start(over: Partial<WorkerOptions> & Pick<WorkerOptions, "handlers">): Promise<Worker> {
  worker = createWorker({
    apiUrl: api.url,
    apiKey: KEY,
    pollWaitMs: 30,
    drainTimeoutMs: 1_000,
    logger: {
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
    ...over,
  });
  return worker.start().then(() => worker!);
}

const reports = (kind: "complete" | "fail") => api.calls("POST", new RegExp(`/${kind}$`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

describe("registration", () => {
  it("registers its handler types, queues and capacity, then long-polls with its free capacity", async () => {
    await start({ handlers: { "a.b": () => 1, c: () => 2 }, queues: ["q1"], capabilities: ["gpu"], concurrency: 3, cpu: 6, memoryMb: 900 });
    const [reg] = api.calls("POST", /^\/v1\/workers$/);
    expect(reg!.body).toMatchObject({ queues: ["q1"], capabilities: ["gpu"], taskTypes: ["a.b", "c"], maxConcurrency: 3, cpu: 6, memoryMb: 900, sdkVersion: "0.1.0" });
    await until(() => api.calls("POST", /\/poll$/).length > 0);
    expect(api.calls("POST", /\/poll$/)[0]!.body).toEqual({ freeSlots: 3, freeCpu: 6, freeMemoryMb: 900, waitMs: 30 });
    expect(worker!.id).toBe("w-1");
  });

  it("retries registration on transient errors and fails fast on permanent ones", async () => {
    let n = 0;
    api.on("POST", /^\/v1\/workers$/, () =>
      ++n < 2 ? { status: 503, body: { error: { code: "database_unavailable", message: "x" } } } : { status: 201, body: { workerId: "w-x", heartbeatIntervalMs: 50 } },
    );
    await start({ handlers: { job: () => 1 } });
    expect(n).toBe(2);
    expect(worker!.id).toBe("w-x");
    await worker!.stop();

    api.on("POST", /^\/v1\/workers$/, () => ({ status: 403, body: { error: { code: "forbidden", message: "Missing scope worker" } } }));
    worker = createWorker({ apiUrl: api.url, apiKey: KEY, handlers: { job: () => 1 } });
    await expect(worker.start()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    worker = null;
  });

  it("refuses to start without handlers", () => {
    expect(() => createWorker({ apiUrl: api.url, apiKey: KEY, handlers: {} })).toThrow(/handler/);
  });
});

describe("execution and reporting", () => {
  it("runs the handler with the lease context and reports its output", async () => {
    const seen: TaskContext[] = [];
    api.pending.push(makeTask({ type: "job", input: { a: 1 }, runInput: { day: "x" }, attempt: 2, fence: 7, checkpoint: { offset: 5 }, idempotencyKey: "run:k" }));
    await start({ handlers: { job: (ctx) => (seen.push(ctx), { ok: true }) } });
    await until(() => reports("complete").length === 1);
    expect(seen[0]).toMatchObject({ input: { a: 1 }, runInput: { day: "x" }, attempt: 2, checkpoint: { offset: 5 }, idempotencyKey: "run:k" });
    expect(reports("complete")[0]!.body).toEqual({ workerId: "w-1", fence: 7, output: { ok: true } });
  });

  it("reports undefined output as null", async () => {
    api.pending.push(makeTask());
    await start({ handlers: { job: () => undefined } });
    await until(() => reports("complete").length === 1);
    expect((reports("complete")[0]!.body as { output: unknown }).output).toBeNull();
  });

  it("reports thrown errors as retryable, NonRetryableError as permanent", async () => {
    api.pending.push(makeTask({ type: "boom" }), makeTask({ type: "bad" }));
    class BoomError extends Error {
      override name = "BoomError";
    }
    await start({
      concurrency: 2,
      handlers: {
        boom: () => {
          throw new BoomError("transient trouble");
        },
        bad: () => {
          throw new NonRetryableError("invalid input", "bad_input");
        },
      },
    });
    await until(() => reports("fail").length === 2);
    const errors = reports("fail").map((r) => (r.body as { error: unknown }).error);
    expect(errors).toEqual(
      expect.arrayContaining([
        { message: "transient trouble", code: "BoomError", retryable: true },
        { message: "invalid input", code: "bad_input", retryable: false },
      ]),
    );
  });

  it("fails a task of a type it has no handler for as non-retryable", async () => {
    api.pending.push(makeTask({ type: "unknown" }));
    await start({ handlers: { job: () => 1 } });
    await until(() => reports("fail").length === 1);
    expect((reports("fail")[0]!.body as { error: unknown }).error).toMatchObject({ code: "no_handler", retryable: false });
  });

  it("aborts a handler at the attempt deadline and reports a timeout", async () => {
    let aborted = false;
    api.pending.push(makeTask({ attemptDeadline: new Date(Date.now() + 100).toISOString(), timeoutMs: 100 }));
    await start({
      handlers: {
        job: async ({ signal }) => {
          await abortable(5_000, signal).catch((e) => {
            aborted = true;
            throw e;
          });
        },
      },
    });
    await until(() => reports("fail").length === 1);
    expect(aborted).toBe(true);
    expect((reports("fail")[0]!.body as { error: unknown }).error).toEqual({ message: "Attempt exceeded timeout of 100ms", code: "timeout", retryable: true });
  });

  it("times attempts from the relative deadline, not by comparing clocks across hosts", async () => {
    // By this host's clock the absolute deadline passed a minute ago (the worker's clock
    // runs ahead of the API's); the relative deadline says 5 s remain. The task must run.
    api.pending.push(makeTask({ attemptDeadline: new Date(Date.now() - 60_000).toISOString(), deadlineInMs: 5_000, timeoutMs: 5_000 }));
    await start({ handlers: { job: async () => (await new Promise((r) => setTimeout(r, 150)), "done") } });
    await until(() => reports("complete").length === 1);
    expect(reports("fail")).toHaveLength(0);
  });

  it("enforces the relative deadline even when this host's clock runs behind", async () => {
    // The absolute deadline looks an hour away here; the relative one is 100 ms.
    api.pending.push(makeTask({ attemptDeadline: new Date(Date.now() + 3_600_000).toISOString(), deadlineInMs: 100, timeoutMs: 100 }));
    const t0 = performance.now();
    await start({ handlers: { job: async ({ signal }) => abortable(5_000, signal) } });
    await until(() => reports("fail").length === 1);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect((reports("fail")[0]!.body as { error: { code: string } }).error.code).toBe("timeout");
  });

  it("hands handlers the run's trace context and sends it with that task's reports", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    let seen: string | null | undefined;
    api.pending.push(makeTask({ traceparent: tp }), makeTask({ traceparent: tp }), makeTask());
    let n = 0;
    await start({
      handlers: {
        job: async (c) => {
          n += 1;
          if (n === 1) {
            seen = c.traceparent;
            await c.saveCheckpoint({ step: 1 });
            return "ok";
          }
          if (n === 2) throw new Error("fails");
          return "untraced";
        },
      },
      concurrency: 1,
    });
    await until(() => reports("complete").length === 2 && reports("fail").length === 1);
    expect(seen).toBe(tp);
    const [checkpoint] = api.calls("POST", /\/checkpoint$/);
    expect(checkpoint!.headers.traceparent).toBe(tp);
    expect(reports("fail")[0]!.headers.traceparent).toBe(tp);
    const completions = reports("complete").map((r) => r.headers.traceparent);
    expect(completions).toEqual([tp, undefined]); // a task without trace context sends no header
  });

  it("saves checkpoints against its own lease", async () => {
    api.pending.push(makeTask({ fence: 4 }));
    await start({ handlers: { job: async (ctx) => void (await ctx.saveCheckpoint({ step: 2 })) } });
    await until(() => reports("complete").length === 1);
    expect(api.calls("POST", /\/checkpoint$/)[0]!.body).toEqual({ workerId: "w-1", fence: 4, checkpoint: { step: 2 } });
  });
});

describe("lease loss and recovery", () => {
  it("aborts a handler whose lease the heartbeat revokes, and reports nothing for it", async () => {
    const task = makeTask();
    api.pending.push(task);
    let signalled = false;
    await start({
      handlers: {
        job: async ({ signal }) => {
          await abortable(5_000, signal).catch((e) => {
            signalled = true;
            throw e;
          });
        },
      },
    });
    await until(() => api.calls("POST", /\/poll$/).length > 1);
    api.revoke.push({ taskId: task.taskId, reason: "cancelled" });
    await until(() => signalled);
    await sleep(100);
    expect(reports("complete")).toHaveLength(0);
    expect(reports("fail")).toHaveLength(0);
    expect(worker!.runningTasks).toBe(0);
    // Heartbeats carried the active lease's fence before the revocation.
    expect(api.calls("POST", /\/heartbeat$/).some((r) => JSON.stringify((r.body as { active: unknown[] }).active).includes(task.taskId))).toBe(true);
  });

  it("retries a report on transient errors until it lands", async () => {
    let n = 0;
    api.on("POST", /\/complete$/, () => (++n < 3 ? { status: 503, body: { error: { code: "database_timeout", message: "x" } } } : { body: { duplicate: false } }));
    api.pending.push(makeTask());
    await start({ handlers: { job: () => 1 } });
    await until(() => n === 3, 5_000, "third report attempt");
    await sleep(50);
    expect(n).toBe(3);
  });

  it("fits failure reports to the API's limits, keeping the non-retryable flag", async () => {
    api.pending.push(makeTask());
    await start({
      handlers: {
        job: () => {
          throw new NonRetryableError("x".repeat(10_000), "c".repeat(300));
        },
      },
    });
    await until(() => reports("fail").length === 1);
    const err = (reports("fail")[0]!.body as { error: { message: string; code: string; retryable: boolean } }).error;
    expect(err.message.length).toBeLessThanOrEqual(4_000);
    expect(err.message.endsWith("… (truncated)")).toBe(true);
    expect(err.code.length).toBeLessThanOrEqual(100);
    expect(err.retryable).toBe(false);
  });

  it("turns an output the API refuses (too large) into a non-retryable failure that says why", async () => {
    api.on("POST", /\/complete$/, () => ({ status: 413, body: { error: { code: "fst_err_ctp_body_too_large", message: "Request body is too large" } } }));
    api.pending.push(makeTask());
    await start({ handlers: { job: () => ({ blob: "x".repeat(100) }) } });
    await until(() => reports("fail").length === 1);
    expect((reports("fail")[0]!.body as { error: unknown }).error).toMatchObject({
      code: "output_rejected",
      retryable: false,
      message: expect.stringMatching(/refused the task's output.*413.*too large/i),
    });
    expect(reports("complete")).toHaveLength(1); // not retried: the same output would be refused again
  });

  it("reports an output that cannot be sent as JSON as a non-retryable failure, without retrying", async () => {
    api.pending.push(makeTask());
    await start({ handlers: { job: () => ({ big: 10n }) } });
    await until(() => reports("fail").length === 1);
    expect((reports("fail")[0]!.body as { error: unknown }).error).toMatchObject({ code: "output_rejected", retryable: false, message: expect.stringMatching(/not JSON-serialisable.*BigInt/i) });
    expect(reports("complete")).toHaveLength(0);
  });

  it("drops a report the API rejects as a lost lease, without retrying", async () => {
    let n = 0;
    api.on("POST", /\/complete$/, () => (n++, { status: 409, body: { error: { code: "lease_lost", message: "Lease is no longer held (stale_fence)" } } }));
    api.pending.push(makeTask());
    await start({ handlers: { job: () => 1 } });
    await until(() => logs.some((l) => l.msg === "task complete rejected"));
    await sleep(100);
    expect(n).toBe(1);
  });

  it("re-registers after being marked offline, abandoning in-flight work", async () => {
    let offline = false;
    api.on("POST", /\/heartbeat$/, () => (offline ? { status: 409, body: { error: { code: "worker_offline", message: "register again" } } } : { body: { renewed: [], revoked: [] } }));
    let aborted = false;
    api.pending.push(makeTask());
    await start({
      handlers: {
        job: async ({ signal }) => {
          await abortable(5_000, signal).catch((e) => {
            aborted = true;
            throw e;
          });
        },
      },
    });
    await until(() => worker!.runningTasks === 1);
    offline = true;
    // Wait on what the client observes; the server counts the registration first.
    await until(() => worker!.id === "w-2", 3_000, "re-registration");
    offline = false;
    await until(() => aborted);
    expect(worker!.id).toBe("w-2");
    expect(reports("fail")).toHaveLength(0);
  });

  it("re-registers exactly once when the heartbeat and an in-flight poll both report it offline", async () => {
    // The API answers every request for w-1 with 409 worker_offline, as it does once
    // the worker has been swept offline.
    const offline = { status: 409, body: { error: { code: "worker_offline", message: "register again" } } };
    let pollSeen = false;
    api.on("POST", /\/w-1\/heartbeat$/, () => offline);
    api.on("POST", /\/w-1\/poll$/, async () => {
      pollSeen = true;
      await sleep(80); // the heartbeat's 409 arrives while this poll is still open
      return offline;
    });
    await start({ handlers: { job: () => 1 } });
    await until(() => pollSeen);
    await until(() => worker!.id === "w-2", 3_000, "re-registration");
    await sleep(300); // let the poll's late 409 and further heartbeats land
    expect(api.workerCount).toBe(2); // the original registration plus exactly one recovery
    expect(worker!.id).toBe("w-2");
  });
});

describe("capacity", () => {
  it("never runs more handlers than its concurrency and advertises remaining capacity", async () => {
    let inFlight = 0;
    let peak = 0;
    for (let i = 0; i < 6; i++) api.pending.push(makeTask({ resources: { cpu: 1, memoryMb: 100 } }));
    await start({
      concurrency: 2,
      cpu: 4,
      memoryMb: 1_000,
      handlers: {
        job: async () => {
          peak = Math.max(peak, ++inFlight);
          await sleep(40);
          inFlight -= 1;
        },
      },
    });
    await until(() => reports("complete").length === 6, 5_000);
    expect(peak).toBe(2);
    const polls = api.calls("POST", /\/poll$/).map((r) => r.body as { freeSlots: number; freeCpu: number; freeMemoryMb: number });
    expect(polls.every((p) => p.freeSlots >= 1 && p.freeSlots <= 2)).toBe(true);
    expect(polls.some((p) => p.freeSlots === 1 && p.freeCpu === 3 && p.freeMemoryMb === 900)).toBe(true);
  });
});

describe("start", () => {
  it("refuses a second start() even while the first is still registering", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.on("POST", /^\/v1\/workers$/, async () => (await gate, { status: 201, body: { workerId: "w-1", leaseDurationMs: 30_000, heartbeatIntervalMs: 50 } }));
    worker = createWorker({ apiUrl: api.url, apiKey: KEY, pollWaitMs: 30, handlers: { job: () => 1 }, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const first = worker.start();
    await expect(worker.start()).rejects.toThrow(/already started/);
    release();
    await first;
    expect(api.calls("POST", /^\/v1\/workers$/)).toHaveLength(1);
  });
});

describe("graceful shutdown", () => {
  it("lets in-flight work finish and report before deregistering", async () => {
    api.pending.push(makeTask());
    let started = false;
    await start({ handlers: { job: async () => ((started = true), await sleep(150), "done") } });
    await until(() => started);
    await worker!.stop();
    const order = api.requests.map((r) => r.path).filter((p) => /complete|deregister/.test(p));
    expect(order).toEqual([expect.stringMatching(/\/complete$/), "/v1/workers/w-1/deregister"]);
    expect((api.calls("POST", /\/heartbeat$/).at(-1)!.body as { draining: boolean }).draining).toBe(true);
  });

  it("keeps heartbeating while it drains, so a long final task keeps its lease", async () => {
    api.pending.push(makeTask());
    let started = false;
    await start({ handlers: { job: async () => ((started = true), await sleep(400), "done") } });
    await until(() => started);
    const before = api.calls("POST", /\/heartbeat$/).length;
    await worker!.stop();
    const during = api.calls("POST", /\/heartbeat$/).slice(before);
    // 400 ms of draining at a 50 ms interval: renewals keep coming, all marked draining.
    expect(during.length).toBeGreaterThanOrEqual(4);
    expect(during.every((r) => (r.body as { draining: boolean }).draining)).toBe(true);
    expect(reports("complete")).toHaveLength(1);
  });

  it("aborts work still running after the drain timeout, reports nothing for it, and deregisters", async () => {
    api.pending.push(makeTask());
    let aborted = false;
    await start({
      drainTimeoutMs: 100,
      handlers: {
        job: async ({ signal }) => {
          await abortable(10_000, signal).catch((e) => {
            aborted = true;
            throw e;
          });
        },
      },
    });
    await until(() => worker!.runningTasks === 1);
    const t0 = performance.now();
    await worker!.stop();
    expect(performance.now() - t0).toBeLessThan(1_000);
    await until(() => aborted);
    expect(reports("fail")).toHaveLength(0);
    expect(api.calls("POST", /\/deregister$/)).toHaveLength(1);
  });

  it("a heartbeat still in flight when shutdown ends does not start another", async () => {
    // Hold one timer-driven heartbeat open at the API until stop() has returned: that is
    // the moment its callback would otherwise reschedule (the handler is still running).
    let holdNext = false;
    let held = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    api.on("POST", /\/heartbeat$/, async () => {
      if (holdNext) {
        holdNext = false;
        held += 1;
        await gate;
      }
      return { body: { renewed: [], revoked: [] } };
    });
    api.pending.push(makeTask());
    let started = false;
    await start({ drainTimeoutMs: 100, handlers: { job: async () => ((started = true), await sleep(1_500), "late") } });
    await until(() => started);
    holdNext = true;
    await until(() => held === 1); // the timer's heartbeat is now in flight
    await worker!.stop();
    const afterStop = api.calls("POST", /\/heartbeat$/).length;
    release();
    await sleep(300); // six intervals: a rescheduled loop would have sent several
    expect(api.calls("POST", /\/heartbeat$/).length).toBe(afterStop);
  });

  it("stops heartbeating when the drain ends, even if a handler ignores the abort", async () => {
    api.pending.push(makeTask());
    let started = false;
    await start({ drainTimeoutMs: 120, handlers: { job: async () => ((started = true), await sleep(600), "late") } });
    await until(() => started);
    await worker!.stop();
    const afterStop = api.calls("POST", /\/heartbeat$/).length;
    await sleep(300); // the handler is still sleeping; 6 heartbeat intervals pass
    expect(api.calls("POST", /\/heartbeat$/).length).toBe(afterStop);
  });

  it("stops promptly even while a long-poll is outstanding", async () => {
    api.on("POST", /\/poll$/, () => ({ hang: true }));
    await start({ handlers: { job: () => 1 }, pollWaitMs: 20_000 });
    await until(() => api.calls("POST", /\/poll$/).length === 1);
    const t0 = performance.now();
    await worker!.stop();
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
