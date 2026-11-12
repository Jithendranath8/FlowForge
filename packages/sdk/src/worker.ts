import { hostname } from "node:os";
import { FlowForgeError, HttpClient, type HttpOptions } from "./http.js";

/** Throw this from a handler to fail the task without retrying (e.g. invalid input). */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export interface TaskContext<I = Record<string, unknown>> {
  taskId: string;
  runId: string;
  /** Task key within the workflow, e.g. "extract". */
  key: string;
  type: string;
  /** 1-based attempt number. Attempts > 1 are retries (or re-deliveries after a crash). */
  attempt: number;
  /** Static input from the task definition. */
  input: I;
  /** Input supplied when the run was started. */
  runInput: Record<string, unknown>;
  /** The last checkpoint saved by a previous attempt of this task, or null. */
  checkpoint: unknown;
  /**
   * Stable for every attempt of this task in this run (`runId:taskKey`). Pass it to
   * external systems (payment APIs, email providers, upserts) so a re-delivered task
   * does not repeat its side effects. FlowForge delivers tasks at least once.
   */
  idempotencyKey: string;
  /** Aborted when the run is cancelled, the lease is lost, the attempt times out, or the worker shuts down. */
  signal: AbortSignal;
  /**
   * W3C `traceparent` of the run's trace, or null when the API does not trace. To put
   * your own spans in the run's trace, extract it with your OpenTelemetry propagator.
   */
  traceparent: string | null;
  /** Persist progress; a retried attempt receives it as `checkpoint`. Max 256 KiB JSON. */
  saveCheckpoint(data: unknown): Promise<void>;
}

export type TaskHandler = (ctx: TaskContext) => unknown | Promise<unknown>;

export interface WorkerLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface WorkerOptions extends HttpOptions {
  handlers: Record<string, TaskHandler>;
  name?: string;
  queues?: string[];
  capabilities?: string[];
  /** Max tasks executed at once by this process. */
  concurrency?: number;
  /** Capacity advertised to the scheduler. */
  cpu?: number;
  memoryMb?: number;
  /** Long-poll wait (max 20000). */
  pollWaitMs?: number;
  /** On stop(), how long in-flight tasks may run before being aborted. */
  drainTimeoutMs?: number;
  /** Stop gracefully on SIGTERM / SIGINT. */
  handleSignals?: boolean;
  logger?: WorkerLogger;
}

interface LeasedTask {
  taskId: string;
  runId: string;
  key: string;
  type: string;
  attempt: number;
  fence: number;
  input: Record<string, unknown>;
  runInput: Record<string, unknown>;
  checkpoint: unknown;
  timeoutMs: number;
  resources: { cpu: number; memoryMb: number };
  attemptDeadline: string;
  /** Time left until attemptDeadline when the API sent the lease (absent from older APIs). */
  deadlineInMs?: number;
  idempotencyKey: string;
  /** W3C trace context of the run (null or absent when the API does not trace). */
  traceparent?: string | null;
}

type EndReason = "revoked" | "timeout" | "shutdown";

interface Active {
  task: LeasedTask;
  controller: AbortController;
  endReason: EndReason | null;
}

/** Task-scoped API calls carry the run's trace context, so they join the run's trace. */
const traced = (task: LeasedTask) => (task.traceparent ? { headers: { traceparent: task.traceparent } } : {});

const defaultLogger: WorkerLogger = {
  info: () => {},
  warn: (m, d) => console.warn(`[flowforge] ${m}`, d ?? ""),
  error: (m, d) => console.error(`[flowforge] ${m}`, d ?? ""),
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * A FlowForge worker process. It registers with the API, long-polls for tasks of the
 * types it has handlers for, runs up to `concurrency` at once, heartbeats to keep
 * leases alive, and reports results. Results are reported with retries; the API
 * treats repeated reports of the same attempt as duplicates.
 */
export class Worker {
  private readonly http: HttpClient;
  private readonly log: WorkerLogger;
  private readonly concurrency: number;
  private readonly cpu: number;
  private readonly memoryMb: number;
  private readonly active = new Map<string, Active>();
  private workerId: string | null = null;
  private heartbeatMs = 10_000;
  private started = false;
  private stopping = false;
  private pollAbort = new AbortController();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private slotWaiters: (() => void)[] = [];
  private loop: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private readonly signalHandler = () => void this.stop();

  constructor(private readonly opts: WorkerOptions) {
    const types = Object.keys(opts.handlers);
    if (types.length === 0) throw new Error("At least one handler is required");
    this.http = new HttpClient(opts);
    this.log = opts.logger ?? defaultLogger;
    this.concurrency = opts.concurrency ?? 4;
    this.cpu = opts.cpu ?? this.concurrency;
    this.memoryMb = opts.memoryMb ?? 1024 * this.concurrency;
  }

  get id(): string | null {
    return this.workerId;
  }

  get runningTasks(): number {
    return this.active.size;
  }

  async start(): Promise<void> {
    // Set before the first await, so a second call during registration is refused too.
    if (this.started) throw new Error("Worker already started");
    this.started = true;
    await this.register();
    if (this.opts.handleSignals) {
      process.once("SIGTERM", this.signalHandler);
      process.once("SIGINT", this.signalHandler);
    }
    this.scheduleHeartbeat();
    this.loop = this.pollLoop();
  }

  /** Graceful shutdown: stop polling, let in-flight tasks finish (up to drainTimeoutMs), deregister. */
  async stop(): Promise<void> {
    if (this.stopping) return this.loop ?? undefined;
    this.stopping = true;
    this.pollAbort.abort();
    process.off("SIGTERM", this.signalHandler);
    process.off("SIGINT", this.signalHandler);
    await this.heartbeat(true).catch(() => {});
    const drained = Promise.all([...this.active.values()].map((a) => this.whenFinished(a.task.taskId)));
    const drainTimer = new AbortController();
    await Promise.race([drained, sleep(this.opts.drainTimeoutMs ?? 30_000, drainTimer.signal)]);
    drainTimer.abort(); // release the timer so the process can exit
    for (const a of this.active.values()) this.end(a, "shutdown");
    clearTimeout(this.heartbeatTimer);
    await this.loop;
    if (this.workerId) {
      // Releases any still-leased task immediately so another worker can retry it.
      await this.http.request("POST", `/v1/workers/${this.workerId}/deregister`).catch((e) => this.log.warn("deregister failed", { error: String(e) }));
    }
    this.log.info("worker stopped", { workerId: this.workerId });
  }

  private async register(): Promise<void> {
    const body = {
      name: this.opts.name ?? `${hostname()}-${process.pid}`,
      hostname: hostname(),
      sdkVersion: "1.0.0",
      queues: this.opts.queues ?? ["default"],
      capabilities: this.opts.capabilities ?? [],
      taskTypes: Object.keys(this.opts.handlers),
      maxConcurrency: this.concurrency,
      cpu: this.cpu,
      memoryMb: this.memoryMb,
    };
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.http.request<{ workerId: string; heartbeatIntervalMs: number }>("POST", "/v1/workers", body);
        this.workerId = r.workerId;
        this.heartbeatMs = r.heartbeatIntervalMs;
        this.log.info("worker registered", { workerId: r.workerId, taskTypes: body.taskTypes });
        return;
      } catch (err) {
        if (!(err instanceof FlowForgeError) || !err.transient || this.stopping) throw err;
        const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
        this.log.warn("register failed, retrying", { error: err.message, delayMs: delay });
        await sleep(delay);
      }
    }
  }

  private scheduleHeartbeat() {
    this.heartbeatTimer = setTimeout(async () => {
      await this.heartbeat(this.stopping).catch((e) => this.log.warn("heartbeat failed", { error: String(e) }));
      // While draining, keep renewing the leases of the tasks still running: the drain
      // may outlast a lease (both default to 30 s). stop() clears the timer when it ends.
      // (When the drain ends, stop() aborts what is left, which empties `active` at once.)
      if (!this.stopping || this.active.size > 0) this.scheduleHeartbeat();
    }, this.heartbeatMs);
  }

  private async heartbeat(draining: boolean): Promise<void> {
    const id = this.workerId;
    if (!id) return;
    try {
      const r = await this.http.request<{ revoked: { taskId: string; reason: string }[] }>("POST", `/v1/workers/${id}/heartbeat`, {
        draining,
        active: [...this.active.values()].map((a) => ({ taskId: a.task.taskId, fence: a.task.fence })),
      });
      for (const rv of r.revoked) {
        const a = this.active.get(rv.taskId);
        if (a) {
          this.log.warn("task lease revoked; aborting handler", { taskId: rv.taskId, reason: rv.reason });
          this.end(a, "revoked");
        }
      }
    } catch (err) {
      if (err instanceof FlowForgeError && err.code === "worker_offline") await this.recoverFromOffline(id);
      else throw err;
    }
  }

  /**
   * The API declared worker `staleId` dead (missed heartbeats). Its leases are gone:
   * abort in-flight work and re-register. The heartbeat and an in-flight poll usually
   * both see the 409, so recovery is single-flight, and a signal about an id we have
   * already replaced is ignored. Otherwise each signal would register another worker
   * row, and the orphans would count against the tenant's max_active_workers quota.
   */
  private recoverFromOffline(staleId: string): Promise<void> {
    if (this.workerId !== staleId) return this.recovering ?? Promise.resolve();
    this.recovering ??= (async () => {
      this.log.warn("worker was marked offline; aborting in-flight tasks and re-registering", { workerId: staleId });
      for (const a of this.active.values()) this.end(a, "revoked");
      if (!this.stopping) await this.register();
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    let pollId = this.workerId!;
    while (!this.stopping) {
      const free = this.concurrency - this.active.size;
      if (free <= 0) {
        await new Promise<void>((r) => this.slotWaiters.push(r));
        continue;
      }
      let used = { cpu: 0, memoryMb: 0 };
      for (const a of this.active.values()) used = { cpu: used.cpu + a.task.resources.cpu, memoryMb: used.memoryMb + a.task.resources.memoryMb };
      try {
        const wait = Math.min(this.opts.pollWaitMs ?? 20_000, 20_000);
        pollId = this.workerId!;
        const r = await this.http.request<{ tasks: LeasedTask[] }>(
          "POST",
          `/v1/workers/${pollId}/poll`,
          { freeSlots: free, freeCpu: Math.max(0, this.cpu - used.cpu), freeMemoryMb: Math.max(0, this.memoryMb - used.memoryMb), waitMs: wait },
          { signal: this.pollAbort.signal, timeoutMs: wait + 15_000 },
        );
        failures = 0;
        for (const t of r.tasks) this.execute(t);
      } catch (err) {
        if (this.stopping) break;
        if (err instanceof FlowForgeError && err.code === "worker_offline") {
          await this.recoverFromOffline(pollId).catch((e) => this.log.error("re-register failed", { error: String(e) }));
          continue;
        }
        failures += 1;
        const delay = Math.min(500 * 2 ** (failures - 1), 15_000);
        this.log.warn("poll failed", { error: String(err), delayMs: delay });
        await sleep(delay, this.pollAbort.signal);
      }
    }
  }

  private end(a: Active, reason: EndReason) {
    if (a.endReason) return;
    a.endReason = reason;
    a.controller.abort(new Error(`task ${reason}`));
  }

  private finishWaiters = new Map<string, (() => void)[]>();
  private whenFinished(taskId: string): Promise<void> {
    if (!this.active.has(taskId)) return Promise.resolve();
    return new Promise((r) => this.finishWaiters.set(taskId, [...(this.finishWaiters.get(taskId) ?? []), r]));
  }

  private execute(task: LeasedTask): void {
    const a: Active = { task, controller: new AbortController(), endReason: null };
    this.active.set(task.taskId, a);
    // Prefer the relative deadline: comparing the API's timestamp with this host's clock
    // would cut the attempt short (or overrun it) by the clock skew between the hosts.
    const deadlineMs = task.deadlineInMs ?? new Date(task.attemptDeadline).getTime() - Date.now();
    const timer = setTimeout(() => this.end(a, "timeout"), Math.max(0, deadlineMs));
    const handler = this.opts.handlers[task.type];
    const ctx: TaskContext = {
      taskId: task.taskId,
      runId: task.runId,
      key: task.key,
      type: task.type,
      attempt: task.attempt,
      input: task.input,
      runInput: task.runInput,
      checkpoint: task.checkpoint ?? null,
      idempotencyKey: task.idempotencyKey,
      signal: a.controller.signal,
      traceparent: task.traceparent ?? null,
      saveCheckpoint: (data) =>
        this.http.request("POST", `/v1/tasks/${task.taskId}/checkpoint`, { workerId: this.workerId, fence: task.fence, checkpoint: data }, traced(task)),
    };

    void (async () => {
      try {
        if (!handler) throw new NonRetryableError(`No handler registered for task type "${task.type}"`, "no_handler");
        const output = await raceAbort(Promise.resolve().then(() => handler(ctx)), a.controller.signal);
        if (a.endReason) return; // revoked/shutdown: someone else owns the outcome
        const value = output === undefined ? null : output;
        try {
          JSON.stringify(value);
        } catch (err) {
          // Sending it would fail the same way every time: record why, once, as permanent.
          await this.report(task, "fail", {
            error: reportableError(`The task's output is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`, "output_rejected", false),
          });
          return;
        }
        await this.report(task, "complete", { output: value });
      } catch (err) {
        if (a.endReason === "revoked" || a.endReason === "shutdown") return;
        const timedOut = a.endReason === "timeout";
        const e = err instanceof Error ? err : new Error(String(err));
        await this.report(task, "fail", {
          error: reportableError(
            timedOut ? `Attempt exceeded timeout of ${task.timeoutMs}ms` : e.message || e.name,
            timedOut ? "timeout" : err instanceof NonRetryableError ? (err.code ?? "non_retryable") : e.name,
            !(err instanceof NonRetryableError),
          ),
        });
      } finally {
        clearTimeout(timer);
        this.active.delete(task.taskId);
        for (const r of this.finishWaiters.get(task.taskId) ?? []) r();
        this.finishWaiters.delete(task.taskId);
        this.slotWaiters.splice(0).forEach((r) => r());
      }
    })();
  }

  /** Report an outcome, retrying transient failures. The API dedupes repeated reports of one attempt. */
  private async report(task: LeasedTask, kind: "complete" | "fail", body: Record<string, unknown>): Promise<void> {
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await this.http.request("POST", `/v1/tasks/${task.taskId}/${kind}`, { workerId: this.workerId, fence: task.fence, ...body }, traced(task));
        return;
      } catch (err) {
        if (err instanceof FlowForgeError && !err.transient) {
          this.log.warn(`task ${kind} rejected`, { taskId: task.taskId, code: err.code, message: err.message });
          // The API refused the output itself (too large, not JSON): the same output would be
          // refused again, so record a permanent failure that says why, instead of leaving
          // the attempt to expire as a lost lease.
          if (kind === "complete" && (err.status === 400 || err.status === 413 || err.status === 422)) {
            await this.report(task, "fail", {
              error: reportableError(`The API refused the task's output (${err.status} ${err.code}): ${err.message}`, "output_rejected", false),
            });
          }
          // 409 lease_lost: the lease expired or moved; the new owner's result wins.
          return;
        }
        if (attempt === 6) {
          this.log.error(`task ${kind} could not be reported; the lease will expire and the task will be retried`, { taskId: task.taskId });
          return;
        }
        await sleep(Math.min(250 * 2 ** (attempt - 1), 5_000));
      }
    }
  }
}

/** Resolve with the handler's result, or reject as soon as the signal aborts. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function createWorker(opts: WorkerOptions): Worker {
  return new Worker(opts);
}

/** The API's limits for a failure report (FailBody in apps/api/src/http/validation.ts). */
const MAX_ERROR_MESSAGE = 4_000;
const MAX_ERROR_CODE = 100;

/**
 * Characters the API refuses because its database cannot store them: NUL and unpaired
 * UTF-16 surrogates. In an error report they become U+FFFD, so the report is accepted.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * An error report the API accepts: an over-long message or code is cut and unstorable
 * characters are replaced, never rejected. A rejected report would leave the attempt to
 * expire as a lost lease, hiding the handler's real error.
 */
function reportableError(message: string, code: string, retryable: boolean) {
  const suffix = "… (truncated)";
  const m = message || "Error";
  // Cut first, then replace: a cut can split a surrogate pair and leave half of it.
  const clean = (s: string) => s.replaceAll("\u0000", "\ufffd").replace(LONE_SURROGATE, "\ufffd");
  return {
    message: m.length > MAX_ERROR_MESSAGE ? clean(m.slice(0, MAX_ERROR_MESSAGE - suffix.length)) + suffix : clean(m),
    code: clean(code.slice(0, MAX_ERROR_CODE)),
    retryable,
  };
}
