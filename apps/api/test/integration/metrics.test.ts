import { schema, type DbHandle } from "@flowforge/db";
import { eq, sql } from "drizzle-orm";
import type client from "prom-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { claimTasks, completeTask, failTask, type LeasedTask, type WorkerRow } from "../../src/engine/execution.js";
import { promoteRetries, reapExpiredLeases, startBackgroundLoops } from "../../src/engine/maintenance.js";
import { cancelRun, submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp } from "../../src/http/app.js";
import { LocalClock } from "../../src/infra/clock.js";
import { KNOWN_LABELS, metrics, registerRuntimeGauges, registry, sampleState, startMetricsServer } from "../../src/infra/metrics.js";
import { NullNotifier } from "../../src/infra/notifier.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Metrics are process-wide (one registry), so every assertion is on the change caused by
 * the code under test, measured between two snapshots.
 */

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
  w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 10, cpu: 8, memoryMb: 8192 });
});

/** Sum of a metric's samples matching the labels (and the series suffix, e.g. "_sum"). */
async function read(metric: client.Metric, labels: Record<string, string> = {}, suffix = ""): Promise<number> {
  const m = await metric.get();
  const values = m.values as (client.MetricValue<string> & { metricName?: string })[];
  return values
    .filter((v) => (suffix ? v.metricName === `${m.name}${suffix}` : !v.metricName || v.metricName === m.name))
    .filter((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))
    .reduce((a, v) => a + v.value, 0);
}

/** Snapshot many series at once; `delta()` returns how much each changed. */
async function snapshot(series: Record<string, [client.Metric, Record<string, string>?, string?]>) {
  const take = async () => Object.fromEntries(await Promise.all(Object.entries(series).map(async ([k, [m, l, s]]) => [k, await read(m, l, s)] as const)));
  const before = await take();
  return { delta: async () => Object.fromEntries(Object.entries(await take()).map(([k, v]) => [k, Math.round((v - before[k]!) * 1000) / 1000])) };
}

const cap = { freeSlots: 10, freeCpu: 8, freeMemoryMb: 8192 };
const fenced = (l: LeasedTask) => ({ tenantId: tenant, taskId: l.taskId, workerId: w.id, fence: l.fence });
const retryOnce = { maxAttempts: 2, initialDelayMs: 1_000, maxDelayMs: 1_000, backoffCoefficient: 1, jitter: 0 };

describe("engine metrics (derived from history events)", () => {
  it("measure queue wait, attempt outcomes and durations, and run duration on the engine clock", async () => {
    await registerWorkflow(ctx, tenant, { name: "pair", tasks: [{ key: "a", type: "job", retry: retryOnce }, { key: "b", type: "job", dependsOn: ["a"] }] });
    const s = await snapshot({
      leased: [metrics.tasksLeased],
      waitCount: [metrics.queueWait, {}, "_count"],
      waitSum: [metrics.queueWait, {}, "_sum"],
      waitLe1: [metrics.queueWait, { le: "1" }, "_bucket"],
      waitLe5: [metrics.queueWait, { le: "5" }, "_bucket"],
      failed: [metrics.attempts, { outcome: "failed" }],
      succeeded: [metrics.attempts, { outcome: "succeeded" }],
      failedSum: [metrics.attemptDuration, { outcome: "failed" }, "_sum"],
      succeededSum: [metrics.attemptDuration, { outcome: "succeeded" }, "_sum"],
      started: [metrics.runsStarted],
      finished: [metrics.runsFinished, { state: "succeeded" }],
      runSum: [metrics.runDuration, { state: "succeeded" }, "_sum"],
      startedEvents: [metrics.events, { type: "task.started" }],
    });

    await submitRun(ctx, tenant, { workflow: "pair", triggeredBy: "test" }); // a queued at t
    clock.advance(5_000);
    let [l] = await claimTasks(ctx, w, cap); // waited 5 s
    clock.advance(2_000);
    await failTask(ctx, { ...fenced(l!), error: { message: "boom" } }); // failed attempt of 2 s, retry in 1 s
    clock.advance(1_000);
    expect(await promoteRetries(ctx)).toBe(1); // queued again
    clock.advance(3_000);
    [l] = await claimTasks(ctx, w, cap); // waited 3 s
    clock.advance(4_000);
    await completeTask(ctx, { ...fenced(l!), output: null }); // succeeded after 4 s; b queued now
    [l] = await claimTasks(ctx, w, cap); // waited 0 s
    clock.advance(1_000);
    await completeTask(ctx, { ...fenced(l!), output: null }); // 1 s; run done 16 s after creation

    expect(await s.delta()).toEqual({
      leased: 3,
      waitCount: 3,
      waitSum: 8,
      waitLe1: 1,
      waitLe5: 3,
      failed: 1,
      succeeded: 2,
      failedSum: 2,
      succeededSum: 5,
      started: 1,
      finished: 1,
      runSum: 16,
      startedEvents: 3,
    });
  });

  it("label expired leases, timeouts and cancelled attempts by outcome", async () => {
    await registerWorkflow(ctx, tenant, {
      name: "solo",
      tasks: [{ key: "a", type: "job", timeoutMs: 60_000, retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffCoefficient: 1, jitter: 0 } }],
    });
    const s = await snapshot({
      expired: [metrics.attempts, { outcome: "lease_expired" }],
      timedOut: [metrics.attempts, { outcome: "timed_out" }],
      cancelled: [metrics.attempts, { outcome: "cancelled" }],
      runsFailed: [metrics.runsFinished, { state: "failed" }],
      runsCancelled: [metrics.runsFinished, { state: "cancelled" }],
    });
    // Lease expiry (30 s lease, 60 s timeout).
    await submitRun(ctx, tenant, { workflow: "solo", triggeredBy: "test" });
    await claimTasks(ctx, w, cap);
    clock.advance(31_000);
    await reapExpiredLeases(ctx);
    // Timeout: heartbeats renewed the lease up to its cap, the attempt deadline (60 s).
    await submitRun(ctx, tenant, { workflow: "solo", triggeredBy: "test" });
    const [l] = await claimTasks(ctx, w, cap);
    await h.db.update(schema.tasks).set({ leaseExpiresAt: sql`attempt_deadline` }).where(eq(schema.tasks.id, l!.taskId));
    clock.advance(61_000);
    await reapExpiredLeases(ctx);
    // Cancelled while running.
    const { run } = await submitRun(ctx, tenant, { workflow: "solo", triggeredBy: "test" });
    await claimTasks(ctx, w, cap);
    await cancelRun(ctx, tenant, run.id, "test");

    expect(await s.delta()).toEqual({ expired: 1, timedOut: 1, cancelled: 1, runsFailed: 2, runsCancelled: 1 });
  });
});

describe("HTTP metrics", () => {
  it("count requests by route template and errors by code, including quota rejections", async () => {
    const app = await buildApp({
      config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent", RATE_LIMIT_IP_PER_MINUTE: 6 },
      ctx,
    });
    try {
      const key = await createApiKey(h, tenant, ["read", "workflows:write"]);
      await h.db.update(schema.tenants).set({ maxWorkflows: 0 }).where(eq(schema.tenants.id, tenant));
      const s = await snapshot({
        runById4xx: [metrics.httpRequests, { route: "/v1/runs/:id", status_class: "4xx" }],
        runByIdCount: [metrics.httpDuration, { route: "/v1/runs/:id", method: "GET" }, "_count"],
        unmatched: [metrics.httpRequests, { route: "unmatched", status_class: "4xx" }],
        notFound: [metrics.httpErrors, { code: "not_found" }],
        routeNotFound: [metrics.httpErrors, { code: "route_not_found" }],
        quota: [metrics.quotaRejections, { quota: "max_workflows" }],
        quotaCode: [metrics.httpErrors, { code: "quota_exceeded" }],
        rateLimited: [metrics.httpErrors, { code: "rate_limited" }],
      });
      const auth = { authorization: `Bearer ${key}` };
      expect((await app.inject({ method: "GET", url: "/v1/runs/00000000-0000-4000-8000-000000000000", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/v1/runs/00000000-0000-4000-8000-000000000001?x=1", headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/nope/123" })).statusCode).toBe(404);
      const put = await app.inject({ method: "PUT", url: "/v1/workflows", headers: auth, payload: { name: "x", tasks: [{ key: "a", type: "job" }] } });
      expect(put.statusCode).toBe(429);
      // Requests 5 and 6 are allowed; the 7th in the minute is refused (still an unmatched route).
      for (let i = 0; i < 3; i++) await app.inject({ method: "GET", url: "/nope" });
      expect(await s.delta()).toEqual({ runById4xx: 2, runByIdCount: 2, unmatched: 4, notFound: 2, routeNotFound: 3, quota: 1, quotaCode: 1, rateLimited: 1 });
      // Raw paths never become labels.
      const exposition = await registry.metrics();
      expect(exposition).not.toContain("00000000-0000-4000-8000");
      expect(exposition).not.toContain("/nope");
    } finally {
      await app.close();
    }
  });
});

describe("system-state gauges", () => {
  it("sample queue depth, oldest queued age, outbox backlog, workers and dead letters", async () => {
    await registerWorkflow(ctx, tenant, {
      name: "three",
      tasks: ["a", "b", "c"].map((key) => ({ key, type: "job", retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffCoefficient: 1, jitter: 0 } })),
    });
    await submitRun(ctx, tenant, { workflow: "three", triggeredBy: "test" }); // 3 queued at t
    clock.advance(90_000);
    const [l] = await claimTasks(ctx, w, { ...cap, freeSlots: 1 }); // 1 running, 2 queued since t
    await failTask(ctx, { ...fenced(l!), error: { message: "x", retryable: false } }); // 1 dead letter, 0 running
    await registerWorker(ctx, tenant, { name: "idle", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 256 });
    clock.advance(60_000);
    await registerWorker(ctx, tenant, { name: "late", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 256 });
    const [{ n: unpublished }] = (await h.sql`select count(*)::int as n from outbox where published_at is null`) as unknown as [{ n: number }];

    await sampleState(ctx);
    expect(await read(metrics.tasks, { state: "queued" })).toBe(2);
    expect(await read(metrics.tasks, { state: "running" })).toBe(0);
    expect(await read(metrics.oldestQueued)).toBe(150);
    expect(await read(metrics.runsActive)).toBe(1);
    expect(await read(metrics.outboxPending)).toBe(unpublished);
    expect(await read(metrics.outboxOldest)).toBe(150); // NullNotifier: nothing relayed since t
    expect(await read(metrics.workers, { state: "active" })).toBe(3);
    expect(await read(metrics.deadLettersOpen)).toBe(1);
    expect(await read(metrics.stateSampleAge)).toBeLessThan(5);
  });
});

describe("background loop metrics", () => {
  it("time each loop and count the rows maintenance changes", async () => {
    await registerWorkflow(ctx, tenant, { name: "solo", tasks: [{ key: "a", type: "job" }] });
    await submitRun(ctx, tenant, { workflow: "solo", triggeredBy: "test" });
    await claimTasks(ctx, w, cap);
    clock.advance(31_000); // the lease is expired for the maintenance loop to reap
    const s = await snapshot({
      ticks: [metrics.loopDuration, { loop: "maintenance" }, "_count"],
      reaped: [metrics.maintenanceRows, { action: "reaped" }],
      relayTicks: [metrics.loopDuration, { loop: "outbox-relay" }, "_count"],
      errors: [metrics.loopErrors, { loop: "maintenance" }],
    });
    const loops = startBackgroundLoops(ctx, { maintenanceIntervalMs: 20, relayIntervalMs: 20, retentionIntervalMs: 3_600_000 });
    try {
      const deadline = performance.now() + 5_000;
      while ((await read(metrics.maintenanceRows, { action: "reaped" })) < 1 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    } finally {
      await loops.stop();
    }
    const d = await s.delta();
    expect(d.reaped).toBe(1);
    expect(d.ticks).toBeGreaterThan(0);
    expect(d.relayTicks).toBeGreaterThan(0);
    expect(d.errors).toBe(0);
  });
});

describe("metrics endpoint", () => {
  it("serves the registry on its own listener, with runtime gauges, and nothing else", async () => {
    registerRuntimeGauges({ db: () => ({ size: 10, inUse: 3, queued: 1 }), notifier: new NullNotifier(), clock: new LocalClock() });
    const server = await startMetricsServer("127.0.0.1", 0, { info: () => {}, error: () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
      const body = await res.text();
      expect(body).toMatch(/^flowforge_db_pool_in_use 3$/m);
      expect(body).toMatch(/^flowforge_db_pool_waiting 1$/m);
      expect(body).toMatch(/^flowforge_redis_enabled 0$/m);
      expect(body).toMatch(/^flowforge_clock_since_sync_seconds -1$/m);
      expect(body).toContain("# TYPE flowforge_task_attempt_duration_seconds histogram");
      // Series that alerts rate() over exist from process start (a series born at its
      // post-incident value shows no increase, so the alert would never fire).
      for (const code of KNOWN_LABELS.errorCodes) expect(body).toMatch(new RegExp(`^flowforge_http_errors_total\\{code="${code}"\\} \\d+$`, "m"));
      for (const loop of KNOWN_LABELS.loops) expect(body).toMatch(new RegExp(`^flowforge_background_loop_duration_seconds_count\\{loop="${loop}"\\} \\d+$`, "m"));
      for (const outcome of KNOWN_LABELS.outcomes) expect(body).toMatch(new RegExp(`^flowforge_task_attempts_total\\{outcome="${outcome}"\\} \\d+$`, "m"));
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${server.port}/metrics`, { method: "POST" })).status).toBe(404);
      // Re-registering (a second app in one process) replaces the gauges instead of throwing.
      registerRuntimeGauges({ db: () => ({ size: 5, inUse: 0, queued: 0 }), notifier: new NullNotifier(), clock: new LocalClock() });
      expect(await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text()).toMatch(/^flowforge_db_pool_size 5$/m);
    } finally {
      await server.close();
    }
  });
});
