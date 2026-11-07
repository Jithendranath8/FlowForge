import { schema, type DbHandle } from "@flowforge/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimTasks, completeTask, failTask, renewLeases, saveCheckpoint, type LeasedTask, type WorkerRow } from "../../src/engine/execution.js";
import { markOfflineWorkers, promoteRetries, reapExpiredLeases, relayOutbox, resumeStalledRuns } from "../../src/engine/maintenance.js";
import { cancelRun, retryTask, submitRun } from "../../src/engine/runs.js";
import { deregisterWorker, registerWorker, touchWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp } from "../../src/http/app.js";
import { DatabaseClock, postgresTimeSource } from "../../src/infra/clock.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase, timestampsOutside } from "./harness.js";

/*
 * ADR-015: one engine clock. The audit (I11) found events, outbox rows and workflows
 * stamped by the database clock while tasks used ctx.now(). These tests run the engine
 * on a clock set years away from the database's, drive every write path, and require
 * every engine-written timestamp to come from that clock.
 */

let h: DbHandle;
beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
});

const retryOnce = { maxAttempts: 2, initialDelayMs: 1_000, maxDelayMs: 1_000, backoffCoefficient: 1, jitter: 0 };
const cap = { freeSlots: 4, freeCpu: 4, freeMemoryMb: 4096 };

describe("one engine clock (ADR-015)", () => {
  it("stamps every engine-written timestamp with ctx.now(), on every write path", async () => {
    const clock = new TestClock();
    clock.t = new Date("2001-02-03T04:05:06.000Z"); // decades from the database clock
    const start = clock.now();
    const ctx = makeContext(h, clock);
    const tenant = await createTenant(h, "clock");
    const fenced = (w: WorkerRow, l: LeasedTask) => ({ tenantId: tenant, taskId: l.taskId, workerId: w.id, fence: l.fence });
    // Checked after every phase: a later write could otherwise overwrite a bad value
    // before a single final check sees it. Deadlines, lease expiries and retry times lie
    // ahead of the engine clock, so the window extends a day past it; the database clock
    // is decades away either way.
    const expectEngineClockOnly = async (phase: string) =>
      expect(await timestampsOutside(h, start, new Date(clock.now().getTime() + 86_400_000)), phase).toEqual([]);
    const one = async (w: WorkerRow) => {
      const leased = await claimTasks(ctx, w, cap);
      expect(leased).toHaveLength(1);
      return leased[0]!;
    };

    const tasks = [
      { key: "a", type: "job", retry: retryOnce },
      { key: "b", type: "job", dependsOn: ["a"] },
    ];
    await registerWorkflow(ctx, tenant, { name: "wf", tasks });
    await expectEngineClockOnly("register workflow");
    clock.advance(1_000);
    await registerWorkflow(ctx, tenant, { name: "wf", description: "v2", tasks }); // new version: workflows.updated_at
    const w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 4, cpu: 4, memoryMb: 4096 });
    const run = await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    await expectEngineClockOnly("new version, worker, run");

    // Attempt 1: lease, heartbeat, checkpoint, fail (retry scheduled, failure stats).
    clock.advance(1_000);
    let l = await one(w);
    expect(l.taskId).toBeTruthy();
    clock.advance(1_000);
    await touchWorker(ctx, tenant, w.id, false);
    expect((await renewLeases(ctx, tenant, w.id, [{ taskId: l.taskId, fence: l.fence }])).renewed).toHaveLength(1);
    await saveCheckpoint(ctx, { ...fenced(w, l), checkpoint: { step: 1 } });
    await failTask(ctx, { ...fenced(w, l), error: { message: "boom" } });
    await expectEngineClockOnly("attempt 1");

    // Attempt 2: promoted after backoff, then its lease expires: dead letter, run fails.
    clock.advance(2_000);
    expect(await promoteRetries(ctx)).toBe(1);
    l = await one(w);
    clock.advance(31_000);
    expect(await reapExpiredLeases(ctx)).toBe(1);
    await expectEngineClockOnly("attempt 2 reaped");

    // Manual retry reopens the run and resolves the dead letter; attempt 3 succeeds
    // (success stats), then the run is cancelled with b still queued.
    clock.advance(1_000);
    await retryTask(ctx, tenant, l.taskId, "test");
    l = await one(w);
    clock.advance(1_000);
    await completeTask(ctx, { ...fenced(w, l), output: { ok: true } });
    await expectEngineClockOnly("manual retry, attempt 3 succeeded");
    clock.advance(1_000);
    await cancelRun(ctx, tenant, run.run.id, "test");
    await expectEngineClockOnly("cancel");

    // Deregistration releases a held task; a silent worker goes offline.
    const run2 = await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    await one(w);
    clock.advance(1_000);
    await deregisterWorker(ctx, tenant, w.id);
    await registerWorker(ctx, tenant, { name: "quiet", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 256 });
    clock.advance(61_000);
    expect(await markOfflineWorkers(ctx)).toBe(1);
    await resumeStalledRuns(ctx);
    await relayOutbox(ctx); // no Redis: rows are marked handled with published_at
    await expectEngineClockOnly("deregister, offline, relay");

    // API key use (throttled last_used_at) through the HTTP stack.
    const key = await createApiKey(h, tenant, ["read"]);
    const app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" }, ctx });
    try {
      const res = await app.inject({ method: "GET", url: `/v1/runs/${run2.run.id}`, headers: { authorization: `Bearer ${key}` } });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    await expectEngineClockOnly("API key use");

    // Not vacuous: each class of row the audit flagged exists and was written above.
    const [n] = await h.sql<Record<string, number>[]>`select
      (select count(*) from events)::int as events,
      (select count(*) from outbox where published_at is not null)::int as outbox_published,
      (select count(*) from workflows where updated_at > created_at)::int as workflows_updated,
      (select count(*) from workflow_versions)::int as versions,
      (select count(*) from task_type_stats where samples > 0 and failures > 0)::int as stats,
      (select count(*) from dead_letters where resolved_at is not null)::int as dead_letters_resolved,
      (select count(*) from scheduling_decisions)::int as decisions,
      (select count(*) from api_keys where last_used_at is not null)::int as keys_used,
      (select count(*) from workers where state = 'offline')::int as workers_offline`;
    expect(n).toEqual({
      events: expect.any(Number),
      outbox_published: expect.any(Number),
      workflows_updated: 1,
      versions: 2,
      stats: 1,
      dead_letters_resolved: 1,
      decisions: 4,
      keys_used: 1,
      workers_offline: 2,
    });
    expect(n!.events).toBeGreaterThan(10);
    expect(n!.outbox_published).toBe(n!.events);
    // Events carry the exact engine time of their state change.
    const [ev] = await h.db.select().from(schema.events).where(eq(schema.events.type, "run.cancelled"));
    expect(ev!.createdAt.toISOString()).toBe("2001-02-03T04:05:45.000Z");
  });

  it("flags a timestamp written by the database clock (the check is not vacuous)", async () => {
    const clock = new TestClock();
    clock.t = new Date("2001-02-03T04:05:06.000Z");
    const ctx = makeContext(h, clock);
    const tenant = await createTenant(h, "probe");
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }] });
    // Simulate the pre-ADR-015 behaviour: an insert that relies on the column default.
    await h.db.insert(schema.events).values({ tenantId: tenant, type: "run.created", data: {} });
    const bad = await timestampsOutside(h, clock.now(), clock.now());
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/^events\.created_at: 1 row/);
  });
});

describe("DatabaseClock against Postgres", () => {
  it("tracks the database server's clock within the measured sync uncertainty", async () => {
    const clock = await DatabaseClock.start(postgresTimeSource(h.db), { syncIntervalMs: 60_000, samples: 5 });
    try {
      const s = clock.stats();
      expect(s).toMatchObject({ source: "database", syncs: 1, syncFailures: 0 });
      // Recorded for the evidence log: the database host's clock vs this host's.
      console.warn(`[clock] database clock - host clock = ${s.offsetMs.toFixed(1)} ms (sync uncertainty ±${s.uncertaintyMs.toFixed(2)} ms)`);
      for (let i = 0; i < 20; i++) {
        const before = clock.now().getTime();
        const rows = await h.db.execute<{ ms: number }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`);
        const after = clock.now().getTime();
        const server = Number([...rows][0]!.ms);
        // The server read its clock between our two readings, give or take the sync error
        // (and 1 ms of Date resolution on each side).
        const tolerance = clock.stats().uncertaintyMs + 2;
        expect(server).toBeGreaterThanOrEqual(before - tolerance);
        expect(server).toBeLessThanOrEqual(after + tolerance);
      }
    } finally {
      clock.stop();
    }
  });
});
