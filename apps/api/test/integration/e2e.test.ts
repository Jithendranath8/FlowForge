import { schema, type DbHandle } from "@flowforge/db";
import { FlowForgeClient } from "@flowforge/sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { startBackgroundLoops } from "../../src/engine/maintenance.js";
import { buildApp } from "../../src/http/app.js";
import { RedisNotifier } from "../../src/infra/notifier.js";
import { REDIS_TEST_URL, createApiKey, createTenant, resetData, setupDatabase } from "./harness.js";
import { WorkerPool, exited, retryIfSuspended, waitUntil } from "./process-harness.js";

/*
 * End-to-end tests with real worker *processes* (the SDK runtime) against an in-process
 * API server, Postgres and Redis. Lease/heartbeat timings are shortened so crash
 * recovery completes within seconds. Elapsed times use the monotonic clock, and the
 * timing-sensitive crash scenario is re-run only if the host was suspended during it
 * (see retryIfSuspended).
 */

const LEASE_MS = 2_500;

let h: DbHandle;
let app: FastifyInstance;
let notifier: RedisNotifier;
let address: string;
let background: { stop: () => Promise<void> };
let client: FlowForgeClient;
let workerKey: string;
let pool: WorkerPool;

beforeAll(async () => {
  h = await setupDatabase();
  notifier = new RedisNotifier(REDIS_TEST_URL, pino({ level: "silent" }));
  const ctx: EngineContext = {
    db: h.db,
    now: () => new Date(),
    notifier,
    log: pino({ level: "silent" }),
    leaseDurationMs: LEASE_MS,
    heartbeatIntervalMs: 500,
    workerOfflineAfterMs: 5_000,
  };
  app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 1 << 20, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" }, ctx });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  // The same loops production runs (maintenance and outbox relay are independent).
  background = startBackgroundLoops(ctx, { maintenanceIntervalMs: 150, relayIntervalMs: 50, retentionIntervalMs: 3_600_000 });
});

afterAll(async () => {
  await background?.stop(); // never close the pool under an in-flight tick
  await app?.close();
  await notifier?.close();
  await h?.close();
});

beforeEach(async () => {
  await resetData(h);
  const tenant = await createTenant(h, "e2e");
  client = new FlowForgeClient({ apiUrl: address, apiKey: await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]) });
  workerKey = await createApiKey(h, tenant, ["worker"]);
  pool = new WorkerPool();
  if (process.env.E2E_TRACE) console.warn(`[trace] logs in ${pool.logFile} api ${address}`);
});

afterEach(() => pool.killAll());

const startWorker = (name: string, concurrency = 4) => pool.start({ apiUrl: address, apiKey: workerKey, name, concurrency });

/** On failure with E2E_TRACE set, print the state needed to diagnose it. */
async function dumpDiagnostics(runId: string) {
  const out = (label: string, v: unknown) => console.warn(`[diag] ${label}: ${JSON.stringify(v)}`);
  out("node now", new Date().toISOString());
  out("pg now", (await h.sql`select clock_timestamp() as t`)[0]);
  out("tasks", await h.sql`select key, state, attempts, fence, worker_id, lease_expires_at, available_at, enqueued_at from tasks where run_id = ${runId}`);
  out("attempts", await h.sql`select attempt, outcome, worker_id, started_at, finished_at from task_attempts where run_id = ${runId}`);
  out("workers", await h.sql`select id, name, state, last_heartbeat_at from workers`);
  out("outbox unpublished", await h.sql`select count(*)::int as n from outbox where published_at is null`);
  out("redis", notifier.health());
  out("execution log", pool.executions());
}

describe("end-to-end with worker processes", () => {
  it("distributes a fan-out/fan-in workflow across workers, executing each task once", async () => {
    await client.registerWorkflow({
      name: "fan",
      tasks: [
        { key: "split", type: "e2e.step" },
        ...[1, 2, 3, 4, 5].map((i) => ({ key: `part${i}`, type: "e2e.step", dependsOn: ["split"], input: { ms: 60 } })),
        { key: "merge", type: "e2e.step", dependsOn: ["part1", "part2", "part3", "part4", "part5"] },
      ],
    });
    await Promise.all([startWorker("a"), startWorker("b"), startWorker("c")]);
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => client.startRun("fan", { input: { i } })));
    const results = await Promise.all(runs.map((r) => client.waitForRun(r.id, { timeoutMs: 30_000, intervalMs: 100 })));

    expect(results.every((r) => r.run.state === "succeeded")).toBe(true);
    const all = pool.executions();
    const done = all.filter((e) => e.event === "done");
    expect(done).toHaveLength(8 * 7);
    expect(new Set(done.map((e) => `${e.runId}:${e.key}`)).size).toBe(8 * 7); // no duplicates
    expect(new Set(done.map((e) => e.pid)).size).toBeGreaterThan(1); // distributed

    // merge always starts after every part of the same run finished.
    for (const r of runs) {
      const log = all.filter((e) => e.runId === r.id);
      const mergeStart = log.findIndex((e) => e.key === "merge" && e.event === "start");
      const lastPartDone = Math.max(...[1, 2, 3, 4, 5].map((i) => log.findIndex((e) => e.key === `part${i}` && e.event === "done")));
      expect(mergeStart).toBeGreaterThan(lastPartDone);
    }
  });

  it("recovers a task from a worker killed with SIGKILL mid-execution", { timeout: 400_000 }, async () => {
    await client.registerWorkflow({
      name: "crashy",
      tasks: [{ key: "hang", type: "e2e.hang", retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, backoffCoefficient: 2, jitter: 0 } }],
    });
    await retryIfSuspended(3, async () => {
      pool.killAll();
      pool.resetLog();
      const victim = await startWorker("victim", 1);
      const run = await client.startRun("crashy", { input: { hangMs: 1_500 } });
      await waitUntil(() => pool.executions().some((e) => e.event === "start"), 10_000, "task to start on victim");
      expect(pool.executions()[0]!.pid).toBe(victim.pid);

      const killedAt = performance.now();
      victim.kill("SIGKILL"); // no graceful shutdown, no deregistration
      await exited(victim);
      const survivor = await startWorker("survivor", 1);

      const final = await client.waitForRun(run.id, { timeoutMs: 15_000, intervalMs: 100 }).catch(async (err) => {
        if (process.env.E2E_TRACE) await dumpDiagnostics(run.id);
        throw err;
      });
      const recoveryMs = Math.round(performance.now() - killedAt);
      expect(final.run.state).toBe("succeeded");
      expect(final.tasks[0]!.attempts).toBe(2);
      const done = pool.executions().filter((e) => e.event === "done");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ pid: survivor.pid, attempt: 2 });

      const attempts = await h.db.select().from(schema.taskAttempts).where(eq(schema.taskAttempts.taskId, final.tasks[0]!.id));
      expect(attempts.map((a) => a.outcome).sort()).toEqual(["lease_expired", "succeeded"]);
      // Bounded by lease (2.5s) + maintenance tick + retry delay + execution (1.5s).
      expect(recoveryMs).toBeLessThan(LEASE_MS + 4_000);
      console.warn(`[e2e] SIGKILL recovery: run succeeded ${recoveryMs} ms after kill (lease ${LEASE_MS} ms, task 1500 ms)`);
    });
  });

  it("drains in-flight work on SIGTERM before exiting", async () => {
    await client.registerWorkflow({ name: "drain", tasks: [{ key: "hang", type: "e2e.hang" }] });
    const w = await startWorker("graceful", 1);
    const run = await client.startRun("drain", { input: { hangMs: 1_200 } });
    await waitUntil(() => pool.executions().some((e) => e.event === "start"), 10_000, "task start");
    w.kill("SIGTERM");
    expect(await exited(w)).toBe(0);
    const final = await client.getRun(run.id);
    expect(final.run.state).toBe("succeeded");
    expect(final.tasks[0]!.attempts).toBe(1);
    const [row] = await h.db.select().from(schema.workers);
    expect(row!.state).toBe("offline");
  });

  it("retries a failing attempt and completes", async () => {
    await client.registerWorkflow({
      name: "flaky",
      tasks: [{ key: "f", type: "e2e.flaky", retry: { maxAttempts: 2, initialDelayMs: 200, maxDelayMs: 200, backoffCoefficient: 1, jitter: 0 } }],
    });
    await startWorker("w", 2);
    const run = await client.startRun("flaky");
    const final = await client.waitForRun(run.id, { timeoutMs: 10_000, intervalMs: 100 });
    expect(final.run.state).toBe("succeeded");
    expect(pool.executions().map((e) => `${e.attempt}:${e.event}`)).toEqual(["1:start", "2:start", "2:done"]);
  });
});
