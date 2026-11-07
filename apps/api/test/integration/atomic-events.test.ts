import { schema, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimTasks, saveCheckpoint, type WorkerRow } from "../../src/engine/execution.js";
import { markOfflineWorkers } from "../../src/engine/maintenance.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { TestClock, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Every state change and its history event (plus the event's outbox row) commit together
 * or not at all. A test-only trigger makes the event insert fail; the change it describes
 * must then be rolled back too, so history never misses a change that happened.
 */

let h: DbHandle;
let clock: TestClock;
let ctx: ReturnType<typeof makeContext>;
let tenant: string;

beforeAll(async () => {
  h = await setupDatabase();
  await h.sql.unsafe(`
    create or replace function ff_test_fail_event() returns trigger language plpgsql as $$
    begin
      if new.type = tg_argv[0] then raise exception 'injected failure writing %', new.type; end if;
      return new;
    end $$;`);
});
afterAll(async () => {
  await h.sql.unsafe(`drop function if exists ff_test_fail_event() cascade`);
  await h.close();
});
beforeEach(async () => {
  await resetData(h);
  clock = new TestClock();
  ctx = makeContext(h, clock);
  tenant = await createTenant(h, "atomic");
});
afterEach(async () => {
  await h.sql.unsafe(`drop trigger if exists ff_test_fail_event on events`);
});

const failEventsOfType = (type: string) => h.sql.unsafe(`create trigger ff_test_fail_event before insert on events for each row execute function ff_test_fail_event('${type}')`);
const eventsOfType = async (type: string) => (await h.db.select().from(schema.events).where(eq(schema.events.type, type))).length;
const outboxRows = async () => (await h.db.select().from(schema.outbox)).length;

async function worker(): Promise<WorkerRow> {
  return registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 4, cpu: 4, memoryMb: 4_096 });
}

describe("state changes and their events commit together", () => {
  it("a worker is only marked offline if its worker.offline event is written", async () => {
    const w = await worker();
    clock.advance(ctx.workerOfflineAfterMs + 1_000);
    const outboxBefore = await outboxRows();

    await failEventsOfType("worker.offline");
    await expect(markOfflineWorkers(ctx)).rejects.toThrow(/insert into "events"/);
    const [still] = await h.db.select().from(schema.workers).where(eq(schema.workers.id, w.id));
    expect(still!.state).not.toBe("offline");
    expect(await outboxRows()).toBe(outboxBefore);

    await h.sql.unsafe(`drop trigger ff_test_fail_event on events`);
    expect(await markOfflineWorkers(ctx)).toBe(1);
    const [now] = await h.db.select().from(schema.workers).where(eq(schema.workers.id, w.id));
    expect(now!.state).toBe("offline");
    expect(await eventsOfType("worker.offline")).toBe(1);
    expect(await outboxRows()).toBe(outboxBefore + 1);
  });

  it("a checkpoint is only saved if its task.checkpointed event is written", async () => {
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }] });
    await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    const w = await worker();
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 4, freeMemoryMb: 4_096 });
    const req = { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence };

    await failEventsOfType("task.checkpointed");
    await expect(saveCheckpoint(ctx, { ...req, checkpoint: { page: 3 } })).rejects.toThrow(/insert into "events"/);
    const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, req.taskId));
    expect(task!.checkpoint).toBeNull();

    await h.sql.unsafe(`drop trigger ff_test_fail_event on events`);
    await saveCheckpoint(ctx, { ...req, checkpoint: { page: 3 } });
    const [saved] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.id, req.taskId));
    expect(saved!.checkpoint).toEqual({ page: 3 });
    expect(await eventsOfType("task.checkpointed")).toBe(1);
  });
});

describe("checkpoint size", () => {
  it("is limited in UTF-8 bytes, as its error message says", async () => {
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }] });
    await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    const w = await worker();
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 4, freeMemoryMb: 4_096 });
    const req = { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence };
    // 140,000 characters, but 280,000 bytes: over the 262,144-byte limit.
    await expect(saveCheckpoint(ctx, { ...req, checkpoint: { text: "é".repeat(140_000) } })).rejects.toMatchObject({ status: 413, code: "checkpoint_too_large" });
    await saveCheckpoint(ctx, { ...req, checkpoint: { text: "e".repeat(200_000) } }); // 200,000 bytes fit
  });
});
