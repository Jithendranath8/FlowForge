import { schema, type DbHandle } from "@flowforge/db";
import { FlowForgeClient } from "@flowforge/sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FaultProxy } from "./fault-proxy.js";
import { REDIS_TEST_URL, TEST_URL, createApiKey, createTenant, resetData, setupDatabase } from "./harness.js";
import { WorkerPool, retryIfSuspended, startApi, waitUntil, type ApiProcess } from "./process-harness.js";

/*
 * Process-level chaos: a real API process (apps/api/dist/main.js) and real SDK worker
 * processes, with the API killed/restarted or the worker<->API network delayed or
 * partitioned. Assertions are about invariants — which attempt's result wins, how many
 * times a task completed, what the attempt history records — not just status codes.
 */

let h: DbHandle;
let pool: WorkerPool;
let adminKey: string;
let workerKey: string;
let tenant: string;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
  tenant = await createTenant(h, "chaos");
  adminKey = await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]);
  workerKey = await createApiKey(h, tenant, ["worker"]);
  pool = new WorkerPool();
});
afterEach(async () => {
  pool.killAll();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function api(over: Record<string, string> = {}): Promise<ApiProcess> {
  const a = await startApi({
    DATABASE_URL: TEST_URL,
    REDIS_URL: REDIS_TEST_URL,
    LEASE_DURATION_MS: "2500",
    WORKER_HEARTBEAT_INTERVAL_MS: "500",
    WORKER_OFFLINE_AFTER_MS: "20000",
    MAINTENANCE_INTERVAL_MS: "150",
    OUTBOX_RELAY_INTERVAL_MS: "50",
    ...over,
  });
  cleanups.push(() => a.stop("SIGKILL"));
  return a;
}

const retry = { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, backoffCoefficient: 2, jitter: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attemptsOf(taskId: string) {
  const rows = await h.db.select().from(schema.taskAttempts).where(eq(schema.taskAttempts.taskId, taskId));
  return rows.sort((a, b) => a.attempt - b.attempt).map((a) => a.outcome);
}
async function successEvents(runId: string) {
  return (await h.db.select().from(schema.events).where(and(eq(schema.events.runId, runId), eq(schema.events.type, "task.succeeded")))).length;
}

describe("API process termination", () => {
  it("SIGKILL mid-execution, restarted within the lease: the task completes once, with no re-delivery", { timeout: 400_000 }, async () => {
    await retryIfSuspended(3, async () => {
      pool.killAll();
      pool.resetLog();
      // Long lease: the outage (kill → restart) stays well inside it.
      const a = await api({ LEASE_DURATION_MS: "8000", WORKER_HEARTBEAT_INTERVAL_MS: "1000" });
      const client = new FlowForgeClient({ apiUrl: a.url, apiKey: adminKey });
      await client.registerWorkflow({ name: "job", tasks: [{ key: "t", type: "e2e.hang", retry }] });
      await pool.start({ apiUrl: a.url, apiKey: workerKey, name: "w", concurrency: 1 });
      const run = await client.startRun("job", { input: { hangMs: 2_500 } });
      await waitUntil(() => pool.executions().some((e) => e.event === "start"), 10_000, "task start");

      const killed = await a.stop("SIGKILL");
      expect(killed.code).toBeNull(); // died by signal, no graceful path
      await sleep(500);
      await a.restart();

      const final = await client.waitForRun(run.id, { timeoutMs: 30_000, intervalMs: 100 });
      expect(final.run.state).toBe("succeeded");
      expect(final.tasks[0]!.attempts).toBe(1);
      expect(await attemptsOf(final.tasks[0]!.id)).toEqual(["succeeded"]);
      expect(pool.executions().map((e) => `${e.attempt}:${e.event}`)).toEqual(["1:start", "1:done"]);
      expect(await successEvents(run.id)).toBe(1);
      await a.stop("SIGTERM");
    });
  });

  it("API down longer than the lease: the task is re-delivered after restart and the late result is fenced off", { timeout: 400_000 }, async () => {
    await retryIfSuspended(3, async () => {
      pool.killAll();
      pool.resetLog();
      const a = await api();
      const client = new FlowForgeClient({ apiUrl: a.url, apiKey: adminKey });
      await client.registerWorkflow({ name: "job", tasks: [{ key: "t", type: "e2e.hang", retry }] });
      await pool.start({ apiUrl: a.url, apiKey: workerKey, name: "w", concurrency: 1 });
      const run = await client.startRun("job", { input: { hangMs: 1_500 } });
      await waitUntil(() => pool.executions().some((e) => e.event === "start"), 10_000, "task start");

      await a.stop("SIGKILL");
      // The handler finishes during the outage and its completion report keeps failing;
      // the outage outlasts the lease (2.5 s), so on restart the lease is already dead.
      await waitUntil(() => pool.executions().some((e) => e.attempt === 1 && e.event === "done"), 10_000, "attempt 1 to finish during the outage");
      await sleep(4_000);
      await a.restart();

      const final = await client.waitForRun(run.id, { timeoutMs: 40_000, intervalMs: 200 });
      expect(final.run.state).toBe("succeeded");
      expect(final.tasks[0]!.attempts).toBe(2);
      expect(final.tasks[0]!.output).toMatchObject({ attempt: 2 }); // the late attempt-1 result did not win
      expect(await attemptsOf(final.tasks[0]!.id)).toEqual(["lease_expired", "succeeded"]);
      expect(await successEvents(run.id)).toBe(1);
      await a.stop("SIGTERM");
    });
  });

  it("SIGTERM under load: exits 0 promptly, leaves no database sessions, and workers resume after restart", { timeout: 120_000 }, async () => {
    const a = await api();
    const client = new FlowForgeClient({ apiUrl: a.url, apiKey: adminKey });
    await client.registerWorkflow({ name: "fan", tasks: Array.from({ length: 4 }, (_, i) => ({ key: `p${i}`, type: "e2e.step" })) });
    await pool.start({ apiUrl: a.url, apiKey: workerKey, name: "w", concurrency: 2 });
    const first = await client.startRun("fan");
    expect((await client.waitForRun(first.id, { timeoutMs: 20_000, intervalMs: 100 })).run.state).toBe("succeeded");

    // The worker is now parked in a long-poll; a graceful stop must still be prompt.
    const stopped = await a.stop("SIGTERM");
    expect(stopped.code).toBe(0);
    expect(stopped.ms).toBeLessThan(10_000);
    const sessions = async () =>
      (await h.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = 'flowforge_test' and application_name = 'flowforge-api'`)[0]!.n;
    await waitUntil(async () => (await sessions()) === 0, 5_000, "API database sessions to close");

    await a.restart();
    const second = await client.startRun("fan");
    expect((await client.waitForRun(second.id, { timeoutMs: 30_000, intervalMs: 200 })).run.state).toBe("succeeded");
    await a.stop("SIGTERM");
  });
});

describe("network delay and partition (worker <-> API)", () => {
  it("200 ms latency each way: work completes exactly once with no spurious lease loss", { timeout: 120_000 }, async () => {
    const a = await api();
    const proxy = await FaultProxy.start(a.url);
    cleanups.push(() => proxy.close());
    proxy.latencyMs = 200;
    const client = new FlowForgeClient({ apiUrl: a.url, apiKey: adminKey });
    await client.registerWorkflow({
      name: "fan",
      tasks: [
        { key: "split", type: "e2e.step" },
        ...[1, 2, 3, 4, 5].map((i) => ({ key: `part${i}`, type: "e2e.step", dependsOn: ["split"], input: { ms: 50 } })),
        { key: "merge", type: "e2e.step", dependsOn: ["part1", "part2", "part3", "part4", "part5"] },
      ],
    });
    const viaProxy = proxy.url(a.url).replace(/\/$/, "");
    await Promise.all([pool.start({ apiUrl: viaProxy, apiKey: workerKey, name: "slow-a" }), pool.start({ apiUrl: viaProxy, apiKey: workerKey, name: "slow-b" })]);
    const runs = await Promise.all([0, 1, 2].map(() => client.startRun("fan")));
    const results = await Promise.all(runs.map((r) => client.waitForRun(r.id, { timeoutMs: 60_000, intervalMs: 200 })));
    expect(results.every((r) => r.run.state === "succeeded")).toBe(true);

    const done = pool.executions().filter((e) => e.event === "done");
    expect(done).toHaveLength(3 * 7);
    expect(new Set(done.map((e) => `${e.runId}:${e.key}`)).size).toBe(3 * 7);
    const outcomes = await h.db.select({ outcome: schema.taskAttempts.outcome }).from(schema.taskAttempts);
    expect(outcomes).toHaveLength(3 * 7);
    expect(outcomes.every((o) => o.outcome === "succeeded")).toBe(true);
  });

  it("partition longer than the lease: work moves to a healthy worker and the partitioned worker's result is fenced off", { timeout: 400_000 }, async () => {
    await retryIfSuspended(3, async () => {
      pool.killAll();
      pool.resetLog();
      const a = await api();
      const proxy = await FaultProxy.start(a.url);
      cleanups.push(() => proxy.close());
      const client = new FlowForgeClient({ apiUrl: a.url, apiKey: adminKey });
      await client.registerWorkflow({ name: "job", tasks: [{ key: "t", type: "e2e.hang", retry }] });
      const partitioned = await pool.start({ apiUrl: proxy.url(a.url).replace(/\/$/, ""), apiKey: workerKey, name: "partitioned", concurrency: 1 });
      const run = await client.startRun("job", { input: { hangMs: 1_500 } });
      await waitUntil(() => pool.executions().some((e) => e.event === "start"), 10_000, "task start on the partitioned worker");
      expect(pool.executions()[0]!.pid).toBe(partitioned.pid);

      proxy.pause(); // heartbeats and the eventual completion report are now stuck in the network
      const healthy = await pool.start({ apiUrl: a.url, apiKey: workerKey, name: "healthy", concurrency: 1 });
      const final = await client.waitForRun(run.id, { timeoutMs: 30_000, intervalMs: 200 });
      expect(final.run.state).toBe("succeeded");
      expect(final.tasks[0]!.output).toMatchObject({ attempt: 2, pid: healthy.pid });

      // Heal the partition: the stale heartbeat and late completion report now arrive.
      proxy.resume();
      await waitUntil(() => pool.executions().filter((e) => e.event === "done").length === 2, 10_000, "partitioned handler to finish");
      await sleep(2_000);
      const [task] = await h.db.select().from(schema.tasks).where(eq(schema.tasks.runId, run.id));
      expect(task!.output).toMatchObject({ attempt: 2, pid: healthy.pid }); // still the healthy worker's result
      expect(await attemptsOf(task!.id)).toEqual(["lease_expired", "succeeded"]);
      expect(await successEvents(run.id)).toBe(1);
      await a.stop("SIGTERM");
    });
  });
});
