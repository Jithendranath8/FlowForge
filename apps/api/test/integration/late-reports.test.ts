import { schema, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimTasks, failTask, type WorkerRow } from "../../src/engine/execution.js";
import { reapExpiredLeases } from "../../src/engine/maintenance.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { TestClock, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * A worker's failure report can arrive after the API already resolved the attempt (its
 * lease expired, or it ran past its timeout). Fencing keeps the outcome the API decided;
 * the handler's own error is still kept with that attempt, because it is usually the
 * only explanation of what went wrong.
 */

let h: DbHandle;
let clock: TestClock;
let ctx: ReturnType<typeof makeContext>;
let tenant: string;
let w: WorkerRow;

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetData(h);
  clock = new TestClock();
  ctx = makeContext(h, clock);
  tenant = await createTenant(h, "late");
  await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job", retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 1_000, backoffCoefficient: 1, jitter: 0 } }] });
  await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
  w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 4, memoryMb: 4_096 });
});

const attemptsOf = (taskId: string) => h.db.select().from(schema.taskAttempts).where(eq(schema.taskAttempts.taskId, taskId));

describe("a failure report that arrives after the attempt was resolved", () => {
  it("keeps the handler's error on the attempt, without changing its outcome or the retry", async () => {
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 4, freeMemoryMb: 4_096 });
    clock.advance(ctx.leaseDurationMs + 1_000);
    expect(await reapExpiredLeases(ctx)).toBe(1);
    const [taskBefore] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, lease!.taskId));

    const r = await failTask(ctx, { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence, error: { message: "upstream returned 502 after 40 s", code: "UpstreamError", retryable: true } });
    expect(r.duplicate).toBe(true);

    const [attempt] = await attemptsOf(lease!.taskId);
    expect(attempt!.outcome).toBe("lease_expired");
    expect(attempt!.error).toMatchObject({ kind: "lease_expired", reported: { message: "upstream returned 502 after 40 s", code: "UpstreamError", retryable: true } });
    const [taskAfter] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, lease!.taskId));
    expect({ state: taskAfter!.state, availableAt: taskAfter!.availableAt, attempts: taskAfter!.attempts }).toEqual({ state: taskBefore!.state, availableAt: taskBefore!.availableAt, attempts: taskBefore!.attempts });

    // A retransmission does not overwrite the first report.
    await failTask(ctx, { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence, error: { message: "second copy" } });
    const [again] = await attemptsOf(lease!.taskId);
    expect((again!.error as { reported: { message: string } }).reported.message).toBe("upstream returned 502 after 40 s");
  });

  it("does not touch an attempt the worker itself already reported as failed", async () => {
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 4, freeMemoryMb: 4_096 });
    const req = { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence };
    expect((await failTask(ctx, { ...req, error: { message: "first" } })).duplicate).toBe(false);
    expect((await failTask(ctx, { ...req, error: { message: "retransmitted" } })).duplicate).toBe(true);
    const [attempt] = await attemptsOf(lease!.taskId);
    expect(attempt!.outcome).toBe("failed");
    expect(attempt!.error).not.toHaveProperty("reported");
    expect((attempt!.error as { message: string }).message).toBe("first");
  });
});
