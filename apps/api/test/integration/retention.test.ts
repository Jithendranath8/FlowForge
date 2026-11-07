import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { schema, type DbHandle } from "@flowforge/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { claimTasks, completeTask, failTask, type WorkerRow } from "../../src/engine/execution.js";
import { RETENTION_BACKLOG_PAUSE_MS, relayOutbox, startBackgroundLoops } from "../../src/engine/maintenance.js";
import { DEFAULT_RETENTION, applyRetention, retentionBacklog, type RetentionPolicy } from "../../src/engine/retention.js";
import { cancelRun, retryTask, submitRun } from "../../src/engine/runs.js";
import { deregisterWorker, registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { TEST_URL, TestClock, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";
import { waitUntil } from "./process-harness.js";

const DAY = 86_400_000;

let h: DbHandle;
let clock: TestClock;
let ctx: EngineContext;
let tenant: string;
let w: WorkerRow;

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
  await registerWorkflow(ctx, tenant, {
    name: "pair",
    tasks: [
      { key: "a", type: "job", retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffCoefficient: 1, jitter: 0 } },
      { key: "b", type: "job", dependsOn: ["a"] },
    ],
  });
  w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 50, cpu: 64, memoryMb: 65_536 });
});

const cap = { freeSlots: 50, freeCpu: 64, freeMemoryMb: 65_536 };
/** Only the run category enabled, so other categories cannot interfere with run assertions. */
const runsOnly: RetentionPolicy = { ...DEFAULT_RETENTION, workerEventsDays: 0, schedulingDecisionsDays: 0, offlineWorkersDays: 0, expiredSessionsDays: 0, outboxHours: 8_760 };

async function finishedRun(outcome: "succeeded" | "failed" | "cancelled"): Promise<string> {
  const { run } = await submitRun(ctx, tenant, { workflow: "pair", triggeredBy: "test" });
  if (outcome === "cancelled") {
    await cancelRun(ctx, tenant, run.id, "test");
    return run.id;
  }
  for (;;) {
    const leased = (await claimTasks(ctx, w, cap)).filter((l) => l.runId === run.id);
    if (leased.length === 0) break;
    for (const l of leased) {
      const f = { tenantId: tenant, taskId: l.taskId, workerId: w.id, fence: l.fence };
      if (outcome === "failed") await failTask(ctx, { ...f, error: { message: "boom", retryable: false } });
      else await completeTask(ctx, { ...f, output: { ok: true } });
    }
  }
  const [r] = await h.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id));
  expect(r!.state).toBe(outcome);
  return run.id;
}

async function rowsFor(runIds: string[]) {
  const [n] = await h.sql<Record<string, number>[]>`select
    (select count(*) from workflow_runs where id = any(${runIds}))::int as runs,
    (select count(*) from tasks where run_id = any(${runIds}))::int as tasks,
    (select count(*) from task_attempts where run_id = any(${runIds}))::int as attempts,
    (select count(*) from dead_letters where run_id = any(${runIds}))::int as dead_letters,
    (select count(*) from events where run_id = any(${runIds}))::int as events`;
  return n!;
}

describe("retention of finished runs", () => {
  it("deletes finished runs past the age with all their rows, and keeps younger or unfinished runs", async () => {
    const old = [await finishedRun("succeeded"), await finishedRun("failed"), await finishedRun("cancelled")];
    const unfinished = (await submitRun(ctx, tenant, { workflow: "pair", triggeredBy: "test" })).run.id; // queued, never run
    const before = await rowsFor(old);
    expect(before).toMatchObject({ runs: 3, tasks: 6, dead_letters: 1 });
    expect(before.attempts).toBe(3);

    clock.advance(30 * DAY - 1_000); // just inside the window
    expect((await applyRetention(ctx, runsOnly)).deleted.runs).toBe(0);
    clock.advance(2_000);
    const recent = await finishedRun("succeeded"); // finished at the new "now"

    const r = await applyRetention(ctx, runsOnly);
    expect(r).toMatchObject({ complete: true, deleted: { runs: 3, tasks: 6, run_events: before.events } });
    expect(await rowsFor(old)).toEqual({ runs: 0, tasks: 0, attempts: 0, dead_letters: 0, events: 0 });
    expect((await rowsFor([unfinished, recent])).runs).toBe(2);
    expect((await rowsFor([recent])).events).toBeGreaterThan(0);
    // Idempotent: nothing left to do.
    expect((await applyRetention(ctx, runsOnly)).deleted.runs).toBe(0);
  });

  it("keeps a failed run that was reopened by a manual retry", async () => {
    const id = await finishedRun("failed");
    const [failed] = await h.db.select().from(schema.tasks).where(and(eq(schema.tasks.runId, id), eq(schema.tasks.state, "failed")));
    clock.advance(31 * DAY);
    await retryTask(ctx, tenant, failed!.id, "test"); // reopened: running again, finished_at cleared
    expect((await applyRetention(ctx, runsOnly)).deleted.runs).toBe(0);
    expect((await rowsFor([id])).runs).toBe(1);
  });

  it("skips a run another transaction holds, without waiting, and deletes it on a later pass", async () => {
    const [held, free] = [await finishedRun("succeeded"), await finishedRun("succeeded")];
    clock.advance(31 * DAY);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Simulates a concurrent retryTask/cancel holding the run lock.
    const holder = h.sql.begin(async (tx) => {
      await tx`select id from workflow_runs where id = ${held} for update`;
      locked();
      await released;
    });
    await isLocked;
    const t0 = performance.now();
    const r = await applyRetention(ctx, runsOnly);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.deleted.runs).toBe(1);
    expect((await rowsFor([free])).runs).toBe(0);
    expect((await rowsFor([held])).runs).toBe(1);
    release();
    await holder;
    expect((await applyRetention(ctx, runsOnly)).deleted.runs).toBe(1);
    expect((await rowsFor([held])).runs).toBe(0);
  });

  it("works through a backlog in bounded passes", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) ids.push(await finishedRun("succeeded"));
    clock.advance(31 * DAY);
    const small = { ...runsOnly, batchSize: 20, maxBatches: 3 }; // 2 runs per statement, 3 statements per pass
    const passes: number[] = [];
    for (;;) {
      const r = await applyRetention(ctx, small);
      passes.push(r.deleted.runs);
      if (r.complete) break;
    }
    expect(passes).toEqual([6, 6, 1]);
    expect((await rowsFor(ids)).runs).toBe(0);
  });
});

describe("retention of other data", () => {
  it("applies each category's own age, and keeps unrelayed outbox rows whatever their age", async () => {
    // Day 0: worker events and an offline worker, decisions, relayed outbox rows, a session.
    await finishedRun("succeeded"); // leases write scheduling decisions
    await deregisterWorker(ctx, tenant, w.id); // worker.deregistered event; worker offline
    await relayOutbox(ctx); // no Redis: marks every outbox row relayed
    const [user] = await h.sql<{ id: string }[]>`insert into users (email) values ('u@example.com') returning id`;
    const userId = user!.id;
    await h.sql`insert into sessions (id, user_id, expires_at) values ('s1', ${userId}, ${clock.now().toISOString()})`;
    // An unrelayed row written now: it must survive any age.
    await h.sql`insert into outbox (tenant_id, topic, payload, created_at) values (${tenant}, 'event', '{}', ${clock.now().toISOString()})`;
    const counts = async () => {
      const [c] = await h.sql<Record<string, number>[]>`select
        (select count(*) from events where run_id is null)::int as worker_events,
        (select count(*) from scheduling_decisions)::int as decisions,
        (select count(*) from workers)::int as workers,
        (select count(*) from sessions)::int as sessions,
        (select count(*) from outbox where published_at is not null)::int as relayed,
        (select count(*) from outbox where published_at is null)::int as unrelayed`;
      return c!;
    };
    const start = await counts();
    expect(start).toMatchObject({ worker_events: 2, decisions: 2, workers: 1, sessions: 1, unrelayed: 1 });
    const policy = { ...DEFAULT_RETENTION, runsDays: 0 };

    clock.advance(23 * 3_600_000);
    expect(await applyRetention(ctx, policy)).toMatchObject({ complete: true, deleted: { outbox: 0, expired_sessions: 0 } });

    clock.advance(2 * 3_600_000); // 25 h: outbox (24 h) and expired sessions (1 day)
    let r = await applyRetention(ctx, policy);
    expect(r.deleted).toMatchObject({ outbox: start.relayed, expired_sessions: 1, offline_workers: 0, scheduling_decisions: 0, worker_events: 0 });
    expect(await counts()).toMatchObject({ relayed: 0, unrelayed: 1, sessions: 0 });

    clock.advance(7 * DAY); // offline workers (7 days)
    r = await applyRetention(ctx, policy);
    expect(r.deleted).toMatchObject({ offline_workers: 1, scheduling_decisions: 0, worker_events: 0 });

    clock.advance(7 * DAY); // scheduling decisions (14 days)
    r = await applyRetention(ctx, policy);
    expect(r.deleted).toMatchObject({ scheduling_decisions: 2, worker_events: 0 });

    clock.advance(16 * DAY); // worker events (30 days)
    r = await applyRetention(ctx, policy);
    expect(r.deleted).toMatchObject({ worker_events: 2, runs: 0 });
    expect(await counts()).toEqual({ worker_events: 0, decisions: 0, workers: 0, sessions: 0, relayed: 0, unrelayed: 1 });
    // The run was never eligible (runsDays 0 keeps runs forever).
    expect(await h.db.select().from(schema.workflowRuns)).toHaveLength(1);
  });

  it("keeps everything when every age is 0, except relayed outbox rows", async () => {
    await finishedRun("succeeded");
    await deregisterWorker(ctx, tenant, w.id);
    await relayOutbox(ctx);
    clock.advance(10_000 * DAY);
    const keepAll = { ...DEFAULT_RETENTION, runsDays: 0, workerEventsDays: 0, schedulingDecisionsDays: 0, offlineWorkersDays: 0, expiredSessionsDays: 0 };
    const r = await applyRetention(ctx, keepAll);
    const { outbox, ...rest } = r.deleted;
    expect(outbox).toBeGreaterThan(0);
    expect(Object.values(rest).every((n) => n === 0)).toBe(true);
  });

  it("reports the backlog without deleting anything", async () => {
    await finishedRun("succeeded");
    clock.advance(31 * DAY);
    const backlog = await retentionBacklog(ctx, runsOnly);
    expect(backlog).toMatchObject({ runs: 1, tasks: 2 });
    expect(await h.db.select().from(schema.workflowRuns)).toHaveLength(1);
  });

  it("reports exactly the runs a pass would delete: not a finished run with a task still in flight", async () => {
    await finishedRun("succeeded");
    const inFlight = await finishedRun("failed");
    // A run can finish while one of its tasks is still out (it fails as soon as a task does).
    await h.sql`update tasks set state = 'running' where run_id = ${inFlight} and key = (select min(key) from tasks where run_id = ${inFlight})`;
    clock.advance(31 * DAY);
    const backlog = await retentionBacklog(ctx, runsOnly);
    expect(backlog).toMatchObject({ runs: 1, tasks: 2 });
    const r = await applyRetention(ctx, runsOnly);
    expect(r.deleted.runs).toBe(backlog.runs);
    expect(r.deleted.tasks).toBe(backlog.tasks);
  });
});

describe("retention in the background loop", () => {
  it("drains a backlog across passes without waiting for the next interval", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await finishedRun("succeeded"));
    clock.advance(31 * DAY);
    // 1 run per statement, 2 statements per pass: 3 passes; the interval alone would take an hour.
    const loops = startBackgroundLoops(ctx, {
      maintenanceIntervalMs: 3_600_000,
      relayIntervalMs: 3_600_000,
      retentionIntervalMs: 50,
      retention: { ...runsOnly, batchSize: 10, maxBatches: 2 },
    });
    try {
      await waitUntil(async () => (await rowsFor(ids)).runs === 0, 3 * RETENTION_BACKLOG_PAUSE_MS + 3_000, "backlog drained");
    } finally {
      await loops.stop();
    }
  });
});

describe("flowforge-admin retention", () => {
  const ADMIN = fileURLToPath(new URL("../../dist/admin.js", import.meta.url));
  const admin = (...args: string[]) =>
    spawnSync(process.execPath, [ADMIN, "retention", ...args], {
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_URL, RETENTION_RUNS_DAYS: "1" },
      encoding: "utf8",
    });

  it("reports eligible rows, and deletes them only with --apply", async () => {
    // Runs finished two days ago by the database clock (the admin CLI's engine time).
    const ids = [await finishedRun("succeeded"), await finishedRun("cancelled")];
    await h.db
      .update(schema.workflowRuns)
      .set({ finishedAt: sql`clock_timestamp() - interval '2 days'` })
      .where(inArray(schema.workflowRuns.id, ids));

    const report = admin();
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout)).toMatchObject({ policy: { runsDays: 1 }, eligible: { runs: 2, tasks: 4 } });
    expect(report.stderr).toMatch(/--apply/);
    expect((await rowsFor(ids)).runs).toBe(2);

    const applied = admin("--apply");
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(/"runs": 2/);
    expect((await rowsFor(ids)).runs).toBe(0);
  });

  it("refuses an invalid policy", () => {
    const r = spawnSync(process.execPath, [ADMIN, "retention"], {
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_URL, RETENTION_RUNS_DAYS: "-1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/RETENTION_RUNS_DAYS/);
  });
});
