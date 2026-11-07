import { schema, type DbHandle } from "@flowforge/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { claimTasks, completeTask, failTask, renewLeases, saveCheckpoint, type LeasedTask, type WorkerRow } from "../../src/engine/execution.js";
import { markOfflineWorkers, promoteRetries, reapExpiredLeases, relayOutbox } from "../../src/engine/maintenance.js";
import { cancelRun, retryTask, submitRun } from "../../src/engine/runs.js";
import { deregisterWorker, registerWorker, touchWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { AppError } from "../../src/errors.js";
import { TestClock, createTenant, makeContext, resetData, setupDatabase, timestampsOutside } from "./harness.js";

let h: DbHandle;
let clock: TestClock;
let ctx: EngineContext;
let tenant: string;

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
  clock = new TestClock();
  ctx = makeContext(h, clock);
  tenant = await createTenant(h, "acme");
});
// ADR-015: whatever a test did, every timestamp the engine wrote came from its clock
// (the TestClock starts at 2026-01-01; deadlines and retry times may lie a day ahead).
afterEach(async () => {
  expect(await timestampsOutside(h, new Date("2026-01-01T00:00:00.000Z"), new Date(clock.now().getTime() + 86_400_000))).toEqual([]);
});

const noRetry = { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffCoefficient: 1, jitter: 0 };
const fastRetry = (maxAttempts: number) => ({ maxAttempts, initialDelayMs: 1000, maxDelayMs: 10_000, backoffCoefficient: 2, jitter: 0 });

const diamond = {
  name: "etl",
  tasks: [
    { key: "extract", type: "etl.extract" },
    { key: "clean", type: "etl.clean", dependsOn: ["extract"] },
    { key: "enrich", type: "etl.enrich", dependsOn: ["extract"] },
    { key: "load", type: "etl.load", dependsOn: ["clean", "enrich"] },
  ],
};

async function worker(name = "w1", over: Partial<Parameters<typeof registerWorker>[2]> = {}, t = tenant): Promise<WorkerRow> {
  return registerWorker(ctx, t, {
    name,
    queues: ["default"],
    capabilities: [],
    taskTypes: ["etl.extract", "etl.clean", "etl.enrich", "etl.load", "job", "alert"],
    maxConcurrency: 10,
    cpu: 8,
    memoryMb: 8192,
    ...over,
  });
}
const cap = (freeSlots = 10) => ({ freeSlots, freeCpu: 8, freeMemoryMb: 8192 });
const fenced = (w: WorkerRow, l: LeasedTask) => ({ tenantId: tenant, taskId: l.taskId, workerId: w.id, fence: l.fence });

async function taskStates(runId: string) {
  const rows = await h.db.select({ key: schema.tasks.key, state: schema.tasks.state }).from(schema.tasks).where(eq(schema.tasks.runId, runId));
  return Object.fromEntries(rows.map((r) => [r.key, r.state]));
}
async function runState(runId: string) {
  const [r] = await h.db.select({ state: schema.workflowRuns.state }).from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
  return r!.state;
}
async function expectAppError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

describe("workflow registry", () => {
  it("versions definitions and is idempotent for identical definitions", async () => {
    const a = await registerWorkflow(ctx, tenant, diamond);
    const b = await registerWorkflow(ctx, tenant, { ...diamond, tasks: [...diamond.tasks].reverse().reverse() });
    expect(a).toMatchObject({ version: 1, created: true });
    expect(b).toMatchObject({ version: 1, created: false, versionId: a.versionId });
    const c = await registerWorkflow(ctx, tenant, { ...diamond, description: "v2" });
    expect(c).toMatchObject({ version: 2, created: true });
  });

  it("refuses invalid DAGs with structured issues", async () => {
    const err = await registerWorkflow(ctx, tenant, { name: "bad", tasks: [{ key: "a", type: "t", dependsOn: ["a"] }] }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(422);
    expect(err.details.issues[0]).toMatchObject({ code: "self_dependency" });
  });
});

describe("DAG execution", () => {
  it("runs a diamond to success, honouring dependencies", async () => {
    await registerWorkflow(ctx, tenant, diamond);
    const { run } = await submitRun(ctx, tenant, { workflow: "etl", input: { day: "2026-01-01" }, triggeredBy: "test" });
    expect(await taskStates(run.id)).toEqual({ extract: "queued", clean: "pending", enrich: "pending", load: "pending" });

    const w = await worker();
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const leased = await claimTasks(ctx, w, cap());
      if (leased.length === 0) break;
      for (const l of leased) {
        expect(l.runInput).toEqual({ day: "2026-01-01" });
        expect(l.idempotencyKey).toBe(`${run.id}:${l.key}`);
        order.push(l.key);
        await completeTask(ctx, { ...fenced(w, l), output: { from: l.key } });
      }
    }
    expect(order[0]).toBe("extract");
    expect(order.slice(1, 3).sort()).toEqual(["clean", "enrich"]);
    expect(order[3]).toBe("load");
    expect(await runState(run.id)).toBe("succeeded");

    const events = await h.db.select({ type: schema.events.type }).from(schema.events).where(eq(schema.events.runId, run.id));
    expect(events.filter((e) => e.type === "task.succeeded")).toHaveLength(4);
    expect(events.at(-1)!.type).toBe("run.succeeded");
  });

  it("returns the same run for a repeated idempotency key", async () => {
    await registerWorkflow(ctx, tenant, diamond);
    const a = await submitRun(ctx, tenant, { workflow: "etl", idempotencyKey: "order-42", triggeredBy: "t" });
    const b = await submitRun(ctx, tenant, { workflow: "etl", idempotencyKey: "order-42", triggeredBy: "t" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    const tasks = await h.db.select().from(schema.tasks);
    expect(tasks).toHaveLength(4);
  });

  it("enforces per-run concurrency", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ key: `t${i}`, type: "job" }));
    await registerWorkflow(ctx, tenant, { name: "fan", maxConcurrency: 2, tasks });
    await submitRun(ctx, tenant, { workflow: "fan", triggeredBy: "t" });
    const w = await worker();
    expect(await claimTasks(ctx, w, cap())).toHaveLength(2);
    expect(await claimTasks(ctx, w, cap())).toHaveLength(0);
  });

  it("never leases one task to two concurrent claimers", async () => {
    const tasks = Array.from({ length: 40 }, (_, i) => ({ key: `t${i}`, type: "job" }));
    await registerWorkflow(ctx, tenant, { name: "wide", maxConcurrency: 100, tasks });
    for (let r = 0; r < 3; r++) await submitRun(ctx, tenant, { workflow: "wide", triggeredBy: "t" });
    const workers = await Promise.all(Array.from({ length: 6 }, (_, i) => worker(`w${i}`)));
    const results = await Promise.all(workers.flatMap((w) => [claimTasks(ctx, w, cap(15)), claimTasks(ctx, w, cap(15))]));
    const ids = results.flat().map((l) => l.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    const attempts = await h.db.select().from(schema.taskAttempts);
    expect(attempts).toHaveLength(ids.length);
  });
});

describe("failure handling", () => {
  it("retries with backoff, then dead-letters and applies trigger rules", async () => {
    await registerWorkflow(ctx, tenant, {
      name: "pipe",
      tasks: [
        { key: "a", type: "job", retry: fastRetry(2) },
        { key: "b", type: "job", dependsOn: ["a"] },
        { key: "alert", type: "alert", dependsOn: ["a"], triggerRule: "any_failed" },
      ],
    });
    const { run } = await submitRun(ctx, tenant, { workflow: "pipe", triggeredBy: "t" });
    const w = await worker();

    const [first] = await claimTasks(ctx, w, cap());
    expect(await failTask(ctx, { ...fenced(w, first!), error: { message: "boom" } })).toEqual({ willRetry: true, duplicate: false });
    expect((await taskStates(run.id)).a).toBe("retry_scheduled");

    clock.advance(999);
    expect(await promoteRetries(ctx)).toBe(0);
    clock.advance(1);
    expect(await promoteRetries(ctx)).toBe(1);

    const [second] = await claimTasks(ctx, w, cap());
    expect(second!.attempt).toBe(2);
    expect(second!.fence).toBe(first!.fence + 1);
    expect(await failTask(ctx, { ...fenced(w, second!), error: { message: "boom again" } })).toMatchObject({ willRetry: false });

    expect(await taskStates(run.id)).toEqual({ a: "failed", b: "skipped", alert: "queued" });
    const dl = await h.db.select().from(schema.deadLetters);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ reason: "retries_exhausted", attempts: 2 });

    const [alert] = await claimTasks(ctx, w, cap());
    await completeTask(ctx, { ...fenced(w, alert!), output: null });
    expect(await runState(run.id)).toBe("failed");

    // Manual retry re-opens the run and the skipped downstream task.
    await retryTask(ctx, tenant, first!.taskId, "user:test");
    expect(await runState(run.id)).toBe("running");
    expect(await taskStates(run.id)).toEqual({ a: "queued", b: "pending", alert: "succeeded" });
    const [third] = await claimTasks(ctx, w, cap());
    expect(third!.attempt).toBe(3);
    await completeTask(ctx, { ...fenced(w, third!), output: 1 });
    const [b] = await claimTasks(ctx, w, cap());
    expect(b!.key).toBe("b");
    await completeTask(ctx, { ...fenced(w, b!), output: 2 });
    expect(await runState(run.id)).toBe("succeeded");
    const [resolved] = await h.db.select().from(schema.deadLetters);
    expect(resolved!.resolution).toBe("retried");
  });

  it("does not retry non-retryable errors", async () => {
    await registerWorkflow(ctx, tenant, { name: "nr", tasks: [{ key: "a", type: "job", retry: fastRetry(5) }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "nr", triggeredBy: "t" });
    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    expect(await failTask(ctx, { ...fenced(w, l!), error: { message: "bad input", retryable: false } })).toMatchObject({ willRetry: false });
    expect(await runState(run.id)).toBe("failed");
  });
});

describe("leases, crashes and stale workers", () => {
  it("recovers from a crashed worker and fences off its late completion", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job", retry: fastRetry(3) }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const crashed = await worker("crashed");
    const healthy = await worker("healthy");

    const [lost] = await claimTasks(ctx, crashed, cap());
    clock.advance(30_000); // no heartbeats: lease expires
    expect(await reapExpiredLeases(ctx)).toBe(1);
    const [attempt1] = await h.db.select().from(schema.taskAttempts).where(eq(schema.taskAttempts.attempt, 1));
    expect(attempt1!.outcome).toBe("lease_expired");

    clock.advance(1_000);
    await promoteRetries(ctx);
    const [fresh] = await claimTasks(ctx, healthy, cap());
    expect(fresh!.fence).toBe(lost!.fence + 1);

    // The "crashed" worker comes back (GC pause / partition) and tries to commit.
    await expectAppError(completeTask(ctx, { ...fenced(crashed, lost!), output: "stale" }), "lease_lost");
    const hb = await renewLeases(ctx, tenant, crashed.id, [{ taskId: lost!.taskId, fence: lost!.fence }]);
    expect(hb.revoked).toEqual([{ taskId: lost!.taskId, reason: "stale_fence" }]);

    await completeTask(ctx, { ...fenced(healthy, fresh!), output: "fresh" });
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.runId, run.id));
    expect(task!.output).toBe("fresh");
    expect(await runState(run.id)).toBe("succeeded");
  });

  it("treats a retransmitted completion as a duplicate, not a second execution", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    expect(await completeTask(ctx, { ...fenced(w, l!), output: 1 })).toEqual({ duplicate: false });
    expect(await completeTask(ctx, { ...fenced(w, l!), output: 1 })).toEqual({ duplicate: true });
    const succeeded = await h.db.select().from(schema.events).where(and(eq(schema.events.runId, run.id), eq(schema.events.type, "task.succeeded")));
    expect(succeeded).toHaveLength(1);
  });

  it("renews leases on heartbeat but never past the attempt deadline (timeout)", async () => {
    await registerWorkflow(ctx, tenant, { name: "slow", tasks: [{ key: "a", type: "job", timeoutMs: 45_000, retry: noRetry }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "slow", triggeredBy: "t" });
    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    for (let i = 0; i < 4; i++) {
      clock.advance(10_000);
      const hb = await renewLeases(ctx, tenant, w.id, [{ taskId: l!.taskId, fence: l!.fence }]);
      expect(hb.renewed).toHaveLength(1);
      expect(new Date(hb.renewed[0]!.leaseExpiresAt).getTime()).toBeLessThanOrEqual(new Date(l!.attemptDeadline).getTime());
    }
    expect(await reapExpiredLeases(ctx)).toBe(0); // t=40s, deadline 45s
    clock.advance(5_000);
    expect(await reapExpiredLeases(ctx)).toBe(1);
    const [a] = await h.db.select().from(schema.taskAttempts);
    expect(a!.outcome).toBe("timed_out");
    expect(await runState(run.id)).toBe("failed");
  });

  it("releases leases immediately on graceful worker shutdown", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job", retry: fastRetry(3) }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const w = await worker();
    await claimTasks(ctx, w, cap());
    expect(await deregisterWorker(ctx, tenant, w.id)).toEqual({ released: 1 });
    expect((await taskStates(run.id)).a).toBe("retry_scheduled");
    await expectAppError(touchWorker(ctx, tenant, w.id, false), "worker_offline");
  });

  it("marks silent workers offline and stops leasing to them", async () => {
    const w = await worker();
    clock.advance(61_000);
    expect(await markOfflineWorkers(ctx)).toBe(1);
    await expectAppError(touchWorker(ctx, tenant, w.id, false), "worker_offline");
  });

  it("hands the last checkpoint to the next attempt", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job", retry: fastRetry(3) }] });
    await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    await saveCheckpoint(ctx, { ...fenced(w, l!), checkpoint: { offset: 500 } });
    await failTask(ctx, { ...fenced(w, l!), error: { message: "crash mid-way" } });
    clock.advance(1_000);
    await promoteRetries(ctx);
    const [next] = await claimTasks(ctx, w, cap());
    expect(next!.checkpoint).toEqual({ offset: 500 });
    await expectAppError(saveCheckpoint(ctx, { ...fenced(w, l!), checkpoint: {} }), "lease_lost");
  });
});

describe("cancellation", () => {
  it("cancels all active tasks, revokes leases and rejects late results", async () => {
    await registerWorkflow(ctx, tenant, diamond);
    const { run } = await submitRun(ctx, tenant, { workflow: "etl", triggeredBy: "t" });
    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    await cancelRun(ctx, tenant, run.id, "user:test");
    expect(await runState(run.id)).toBe("cancelled");
    expect(Object.values(await taskStates(run.id)).every((s) => s === "cancelled")).toBe(true);
    const hb = await renewLeases(ctx, tenant, w.id, [{ taskId: l!.taskId, fence: l!.fence }]);
    expect(hb.revoked).toEqual([{ taskId: l!.taskId, reason: "cancelled" }]);
    await expectAppError(completeTask(ctx, { ...fenced(w, l!), output: 1 }), "lease_lost");
    await expectAppError(cancelRun(ctx, tenant, run.id, "x"), "run_not_running");
  });
});

describe("tenant isolation", () => {
  it("does not let another tenant's worker see or touch tasks", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const other = await createTenant(h, "evil");
    const intruder = await worker("intruder", {}, other);
    expect(await claimTasks(ctx, intruder, cap())).toHaveLength(0);

    const w = await worker();
    const [l] = await claimTasks(ctx, w, cap());
    await expectAppError(completeTask(ctx, { tenantId: other, taskId: l!.taskId, workerId: intruder.id, fence: l!.fence, output: 1 }), "not_found");
    await expectAppError(cancelRun(ctx, other, run.id, "x"), "not_found");
  });

  it("rejects cross-tenant rows at the database level", async () => {
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const other = await createTenant(h, "evil");
    await expect(
      h.db.insert(schema.tasks).values({
        tenantId: other, runId: run.id, key: "x", type: "job", queue: "default", priority: 0, triggerRule: "all_succeeded",
        dependsOn: [], retryPolicy: noRetry, timeoutMs: 1000, cpu: 1, memoryMb: 1, requiredCapabilities: [], input: {},
      }),
    ).rejects.toThrow();
  });
});

describe("outbox", () => {
  it("marks rows handled when Redis is not configured", async () => {
    await registerWorkflow(ctx, tenant, diamond);
    await submitRun(ctx, tenant, { workflow: "etl", triggeredBy: "t" });
    expect(await relayOutbox(ctx)).toBeGreaterThan(0);
    expect(await relayOutbox(ctx)).toBe(0);
  });
});
