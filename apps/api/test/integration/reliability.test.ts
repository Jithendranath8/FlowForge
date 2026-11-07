import { DbTimeoutError, classifyDbError, connect, schema, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { claimTasks, failTask } from "../../src/engine/execution.js";
import { relayOutbox, startBackgroundLoops } from "../../src/engine/maintenance.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp } from "../../src/http/app.js";
import { FALLBACK_POLL_MS, NullNotifier, RedisNotifier, type Notifier } from "../../src/infra/notifier.js";
import { FaultProxy } from "./fault-proxy.js";
import { REDIS_TEST_URL, TEST_URL, TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Regression tests for the audit's dependency-degradation defects:
 *  DS-1  a hung Redis stalled all background maintenance and /ready still said "ok";
 *  DS-2  a hung Postgres made requests and /ready hang with no timeout.
 * A FaultProxy freezes traffic exactly like a paused container or black-holed network.
 */

const log = pino({ level: "silent" });
const DB_TIMEOUTS = { statementTimeoutMs: 300, acquireTimeoutMs: 200, queryTimeoutMs: 500, transactionTimeoutMs: 700 };
const REDIS_OPTS = { commandTimeoutMs: 200, healthIntervalMs: 100 };

let h: DbHandle; // direct, unproxied: used to inspect state while the proxy is frozen
let pgProxy: FaultProxy;
let redisProxy: FaultProxy;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  h = await setupDatabase();
  pgProxy = await FaultProxy.start(TEST_URL);
  redisProxy = await FaultProxy.start(REDIS_TEST_URL);
});
afterAll(async () => {
  await pgProxy?.close();
  await redisProxy?.close();
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
});
afterEach(async () => {
  pgProxy.resume();
  redisProxy.resume();
  for (const c of cleanups.splice(0).reverse()) await c();
});

function proxiedDb(max = 3, over: Partial<typeof DB_TIMEOUTS> = {}): DbHandle {
  const d = connect(pgProxy.url(TEST_URL), { max, ...DB_TIMEOUTS, ...over });
  cleanups.push(async () => {
    await until(() => d.stats().inUse === 0, 10_000, "proxied pool to drain");
    await d.close();
  });
  return d;
}

function proxiedRedis(): RedisNotifier {
  const n = new RedisNotifier(redisProxy.url(REDIS_TEST_URL), log, REDIS_OPTS);
  cleanups.push(() => n.close());
  return n;
}

function realClockContext(db: DbHandle, notifier: Notifier): EngineContext {
  const clock = new TestClock();
  clock.now = () => new Date();
  return makeContext(db, clock, notifier);
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function timeoutKind(err: unknown): string | null {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if (e instanceof DbTimeoutError) return e.kind;
  }
  return null;
}

async function timed<T>(p: Promise<T>): Promise<{ ms: number; value?: T; error?: unknown }> {
  const t0 = Date.now();
  try {
    return { ms: Date.now() - t0, value: await p };
  } catch (error) {
    return { ms: Date.now() - t0, error };
  }
}

const idleInTransaction = async () =>
  (await h.sql`select count(*)::int as n from pg_stat_activity where datname = 'flowforge_test' and state like 'idle in transaction%'`)[0]!.n as number;

describe("DS-2: PostgreSQL timeouts", () => {
  it("fails queries fast with typed timeouts while the database hangs, then recovers", async () => {
    const d = proxiedDb(2);
    await d.db.execute(sql`select 1`); // warm a connection
    pgProxy.pause();

    const first = await timed(d.db.execute(sql`select 1`));
    expect(classifyDbError(first.error)).toBe("timeout");
    expect(timeoutKind(first.error)).toBe("query");
    expect(first.ms).toBeLessThan(DB_TIMEOUTS.queryTimeoutMs + 400);

    // The frozen statement still occupies its connection; fill the pool, then the next
    // caller must fail on acquisition rather than queue forever.
    const second = timed(d.db.execute(sql`select 1`));
    const third = await timed(d.db.execute(sql`select 1`));
    expect(timeoutKind(third.error)).toBe("acquire");
    expect(third.ms).toBeLessThan(DB_TIMEOUTS.acquireTimeoutMs + 300);
    expect(timeoutKind((await second).error)).toBe("query");

    pgProxy.resume();
    await until(() => d.stats().inUse === 0, 10_000, "stuck statements to settle");
    expect(await d.db.execute(sql`select 1 as ok`)).toEqual([{ ok: 1 }]);
  });

  it("rolls back a transaction whose deadline fired, so the caller's failure is the truth", async () => {
    const d = proxiedDb();
    const result = await timed(
      d.db.transaction(async (tx) => {
        await tx.insert(schema.tenants).values({ slug: "tx-timeout", name: "x" });
        pgProxy.pause();
        await tx.execute(sql`select 1`); // hangs past the transaction deadline
        await tx.execute(sql`select 2`);
      }),
    );
    expect(timeoutKind(result.error)).toBe("transaction");
    expect(result.ms).toBeLessThan(DB_TIMEOUTS.transactionTimeoutMs + 400);
    pgProxy.resume();
    await until(() => d.stats().inUse === 0, 10_000, "transaction to settle");
    expect(await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, "tx-timeout"))).toEqual([]);
  });

  it("rolls back a timed-out transaction even when the stalled statement was its last", async () => {
    // No statement follows the stall, so only the post-callback expiry check can stop a commit.
    const d = proxiedDb();
    const result = await timed(
      d.db.transaction(async (tx) => {
        await tx.insert(schema.tenants).values({ slug: "tx-timeout-last", name: "x" });
        pgProxy.pause();
        await tx.execute(sql`select 1`);
      }),
    );
    expect(timeoutKind(result.error)).toBe("transaction");
    pgProxy.resume();
    await until(() => d.stats().inUse === 0, 10_000, "transaction to settle");
    expect(await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, "tx-timeout-last"))).toEqual([]);
  });

  it("applies the server-side statement_timeout to slow statements on a live server", async () => {
    const d = proxiedDb();
    const r = await timed(d.db.execute(sql`select pg_sleep(3)`));
    expect(classifyDbError(r.error)).toBe("timeout");
    expect(timeoutKind(r.error)).toBeNull(); // the server cancelled it (57014), not the client deadline
    expect(r.ms).toBeLessThan(DB_TIMEOUTS.queryTimeoutMs);
  });
});

describe("DS-1: Redis is decoupled from correctness-critical maintenance", () => {
  it("reports a hung Redis as degraded quickly and fails publishes within the command timeout", async () => {
    const n = proxiedRedis();
    await until(() => n.healthy(), 5_000, "redis healthy");
    redisProxy.pause();

    const publish = await timed(n.publishEvents([{ tenantId: "t", payload: { type: "x", data: {} } }]));
    expect(publish.error).toBeInstanceOf(Error);
    expect(publish.ms).toBeLessThan(REDIS_OPTS.commandTimeoutMs + 300);

    await until(() => !n.healthy(), 2_000, "redis degraded");
    expect(n.health()).toMatchObject({ status: "degraded", lastError: expect.stringMatching(/timed out/i) });
    const wait = await timed(n.waitForWork("t", ["default"], 20_000));
    expect(wait.ms).toBeLessThan(FALLBACK_POLL_MS + 300); // falls back to short polling

    redisProxy.resume();
    await until(() => n.healthy(), 5_000, "redis healthy again");
  });

  it("keeps promoting retries and reaping while Redis hangs; relay catches up afterwards", async () => {
    const n = proxiedRedis();
    await until(() => n.healthy(), 5_000, "redis healthy");
    const ctx = realClockContext(h, n);
    const tenant = await createTenant(h, "acme");
    await registerWorkflow(ctx, tenant, {
      name: "one",
      tasks: [{ key: "a", type: "job", retry: { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 200, backoffCoefficient: 1, jitter: 0 } }],
    });
    const { run } = await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
    const w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 512 });
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 1, freeMemoryMb: 512 });
    await failTask(ctx, { tenantId: tenant, taskId: lease!.taskId, workerId: w.id, fence: lease!.fence, error: { message: "boom" } });

    redisProxy.pause();
    const loops = startBackgroundLoops(ctx, { maintenanceIntervalMs: 50, relayIntervalMs: 20, retentionIntervalMs: 3_600_000 });
    cleanups.push(() => loops.stop());

    const stateOf = async () => (await h.db.select({ s: schema.tasks.state }).from(schema.tasks).where(eq(schema.tasks.runId, run.id)))[0]!.s;
    await until(async () => (await stateOf()) === "queued", 3_000, "retry promotion while Redis is hung");
    expect(await idleInTransaction()).toBe(0);
    const unpublished = async () => (await h.sql`select count(*)::int as n from outbox where published_at is null`)[0]!.n as number;
    expect(await unpublished()).toBeGreaterThan(0);

    const stopped = await timed(loops.stop());
    expect(stopped.ms).toBeLessThan(REDIS_OPTS.commandTimeoutMs + 500);

    redisProxy.resume();
    await until(() => n.healthy(), 5_000, "redis healthy again");
    await relayOutbox(ctx);
    expect(await unpublished()).toBe(0);
  });

  it("never holds a transaction or row lock while a publish is stuck on a hung Redis", async () => {
    const n = proxiedRedis();
    await until(() => n.healthy(), 5_000, "redis healthy");
    const ctx = realClockContext(h, n);
    const tenant = await createTenant(h, "acme");
    await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
    await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });

    redisProxy.pause(); // health has not noticed yet, so the relay goes ahead and publishes
    const relay = timed(relayOutbox(ctx));
    await new Promise((r) => setTimeout(r, 100));
    expect(await idleInTransaction()).toBe(0);
    const claimed = await h.sql`select count(*)::int as n from outbox where relay_claimed_until is not null and published_at is null`;
    expect(claimed[0]!.n).toBeGreaterThan(0);

    const r = await relay;
    expect(r.error).toBeInstanceOf(Error);
    expect(r.ms).toBeLessThan(REDIS_OPTS.commandTimeoutMs + 400);
    const after = await h.sql`select count(*)::int as unpublished, count(relay_claimed_until)::int as claimed from outbox where published_at is null`;
    expect(after[0]).toMatchObject({ claimed: 0 }); // claim released for a prompt retry
    expect(after[0]!.unpublished).toBeGreaterThan(0);

    redisProxy.resume();
    await until(() => n.healthy(), 5_000, "redis healthy again");
    expect(await relayOutbox(ctx)).toBeGreaterThan(0);
  });
});

describe("Readiness and request behaviour under dependency failure", () => {
  const appConfig = (over: Record<string, unknown> = {}) => ({
    MAX_PAYLOAD_BYTES: 1 << 20,
    allowedOrigins: [],
    NODE_ENV: "test" as const,
    LOG_LEVEL: "silent" as const,
    READY_TIMEOUT_MS: 300,
    ...over,
  });

  it("answers /ready with 503 within the bound while the database hangs, and 200 after", async () => {
    // Long query deadlines, so only the readiness bound itself can explain a prompt answer.
    const d = proxiedDb(3, { queryTimeoutMs: 3_000, transactionTimeoutMs: 3_000 });
    const app = await buildApp({ config: appConfig(), ctx: realClockContext(d, new NullNotifier()) });
    cleanups.push(() => app.close());
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);

    pgProxy.pause();
    const t0 = Date.now();
    const r = await app.inject({ method: "GET", url: "/ready" });
    expect(Date.now() - t0).toBeLessThan(300 + 300);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ status: "not_ready", database: "timeout" });

    pgProxy.resume();
    await until(async () => (await app.inject({ method: "GET", url: "/ready" })).statusCode === 200, 10_000, "ready again");
  });

  it("returns 503 database_timeout from API routes instead of hanging", async () => {
    const d = proxiedDb();
    const app = await buildApp({ config: appConfig(), ctx: realClockContext(d, new NullNotifier()) });
    cleanups.push(() => app.close());
    const key = await createApiKey(h, await createTenant(h, "acme"), ["read"]);
    pgProxy.pause();
    const t0 = Date.now();
    const r = await app.inject({ method: "GET", url: "/v1/runs", headers: { authorization: `Bearer ${key}` } });
    expect(Date.now() - t0).toBeLessThan(DB_TIMEOUTS.queryTimeoutMs + 400);
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("1");
    expect(r.json().error.code).toBe("database_timeout");
  });

  it("reports a degraded Redis truthfully; readiness fails on it only when configured to", async () => {
    const n = proxiedRedis();
    await until(() => n.healthy(), 5_000, "redis healthy");
    const ctx = realClockContext(h, n);
    const lenient = await buildApp({ config: appConfig(), ctx });
    const strict = await buildApp({ config: appConfig({ READY_REQUIRES_REDIS: true }), ctx });
    cleanups.push(() => lenient.close(), () => strict.close());
    expect((await strict.inject({ method: "GET", url: "/ready" })).json()).toMatchObject({ status: "ready", redis: "ok" });

    redisProxy.pause();
    await until(() => !n.healthy(), 2_000, "redis degraded");
    const l = await lenient.inject({ method: "GET", url: "/ready" });
    expect(l.statusCode).toBe(200);
    expect(l.json()).toMatchObject({ status: "ready", database: "ok", redis: "degraded", redisDetail: { lastOkAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) } });
    // The probe is public (also as /api/ready through the web app): no internal error text.
    const reason = n.health().lastError!;
    expect(reason).toBeTruthy();
    expect(l.body).not.toContain(reason);
    expect(l.json().redisDetail).not.toHaveProperty("lastError");
    const s = await strict.inject({ method: "GET", url: "/ready" });
    expect(s.statusCode).toBe(503);
    expect(s.json()).toMatchObject({ status: "not_ready", redis: "degraded" });
  });
});
