import { schema, connect, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Scope } from "../../src/auth/tokens.js";
import { claimTasks, failTask, type WorkerRow } from "../../src/engine/execution.js";
import { promoteRetries, reapExpiredLeases } from "../../src/engine/maintenance.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp, type AppDeps } from "../../src/http/app.js";
import { NullNotifier } from "../../src/infra/notifier.js";
import { FaultProxy } from "./fault-proxy.js";
import { TEST_URL, TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Phase 2: security and resource protection (audit S-1, S-2, S-3, tenant quotas,
 * atomic tenant concurrency, cross-tenant starvation).
 */

let h: DbHandle;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const realClock = () => {
  const c = new TestClock();
  c.now = () => new Date();
  return c;
};

async function app(over: Partial<AppDeps["config"]> = {}, db: DbHandle = h): Promise<FastifyInstance> {
  const a = await buildApp({
    config: { MAX_PAYLOAD_BYTES: 1 << 20, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent", ...over },
    ctx: makeContext(db, realClock(), new NullNotifier()),
  });
  apps.push(a);
  return a;
}

const req = (a: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, auth?: string, payload?: unknown, extra: { ip?: string; headers?: Record<string, string> } = {}) =>
  a.inject({
    method,
    url,
    payload: payload as object,
    remoteAddress: extra.ip ?? "127.0.0.1",
    headers: { ...(auth !== undefined ? { authorization: auth } : {}), ...extra.headers },
  });

async function setQuota(tenantId: string, values: Partial<typeof schema.tenants.$inferInsert>) {
  await h.db.update(schema.tenants).set(values).where(eq(schema.tenants.id, tenantId));
}

const def = (name: string, n = 0) => ({ name, tasks: [{ key: "a", type: "job", input: { n } }] });

async function newTenant(slug: string, scopes: Scope[] = ["read", "workflows:write", "runs:write", "worker"]) {
  const tenant = await createTenant(h, slug);
  return { tenant, key: await createApiKey(h, tenant, scopes) };
}

describe("S-1: per-credential and per-tenant limits key on the authenticated principal", () => {
  it("counts every spelling of the same Authorization header in one bucket", async () => {
    const a = await app({ RATE_LIMIT_KEY_PER_MINUTE: 5, RATE_LIMIT_TENANT_PER_MINUTE: 1_000 });
    const { key } = await newTenant("acme");
    for (let i = 0; i < 5; i++) expect((await req(a, "GET", "/v1/workflows", `Bearer ${key}`)).statusCode).toBe(200);
    // The audit bypass: extra whitespace used to open a fresh bucket.
    for (const variant of [`Bearer ${key}`, `Bearer  ${key}`, `Bearer\t${key}`, `bearer   ${key}`, `Bearer \t ${key}`]) {
      const r = await req(a, "GET", "/v1/workflows", variant);
      expect(r.statusCode).toBe(429);
      expect(r.json().error).toMatchObject({ code: "rate_limited", details: { scope: "credential" } });
      expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    }
  });

  it("caps a tenant across all its keys, without affecting other tenants", async () => {
    const a = await app({ RATE_LIMIT_KEY_PER_MINUTE: 100, RATE_LIMIT_TENANT_PER_MINUTE: 6 });
    const acme = await newTenant("acme");
    const key2 = await createApiKey(h, acme.tenant, ["read"]);
    const other = await newTenant("other");
    for (let i = 0; i < 3; i++) expect((await req(a, "GET", "/v1/workflows", `Bearer ${acme.key}`)).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await req(a, "GET", "/v1/workflows", `Bearer ${key2}`)).statusCode).toBe(200);
    const r = await req(a, "GET", "/v1/workflows", `Bearer ${key2}`);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.details).toEqual({ scope: "tenant" });
    expect((await req(a, "GET", "/v1/workflows", `Bearer ${other.key}`)).statusCode).toBe(200);
  });

  it("advertises the remaining budget", async () => {
    const a = await app({ RATE_LIMIT_KEY_PER_MINUTE: 10, RATE_LIMIT_TENANT_PER_MINUTE: 1_000 });
    const { key } = await newTenant("acme");
    const r = await req(a, "GET", "/v1/workflows", `Bearer ${key}`);
    expect(r.headers["x-ratelimit-limit"]).toBe("10");
    expect(r.headers["x-ratelimit-remaining"]).toBe("9");
  });
});

describe("S-2: failed authentication is rate limited before any database work", () => {
  it("refuses an address after too many failures, without touching the database", async () => {
    const proxy = await FaultProxy.start(TEST_URL);
    const proxied = connect(proxy.url(TEST_URL), { max: 2, acquireTimeoutMs: 300, queryTimeoutMs: 600, transactionTimeoutMs: 700, statementTimeoutMs: 500 });
    try {
      const a = await app({ AUTH_FAILURE_LIMIT: 5, AUTH_FAILURE_WINDOW_MS: 60_000 }, proxied);
      const { key } = await newTenant("acme");
      const bogus = () => `Bearer ffk_AAAAAAAA_${"A".repeat(43)}`;
      for (let i = 0; i < 5; i++) expect((await req(a, "GET", "/v1/workflows", bogus())).statusCode).toBe(401);
      const blocked = await req(a, "GET", "/v1/workflows", bogus());
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("auth_rate_limited");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

      // Proof that no lookup happens: with the database frozen, a blocked address is
      // still answered immediately (a lookup would hang until the query deadline).
      proxy.pause();
      const t0 = Date.now();
      expect((await req(a, "GET", "/v1/workflows", bogus())).statusCode).toBe(429);
      expect((await req(a, "GET", "/v1/workflows", `Bearer ${key}`)).statusCode).toBe(429); // valid keys too, from that address
      expect(Date.now() - t0).toBeLessThan(150);
      proxy.resume();

      // Other addresses are unaffected.
      expect((await req(a, "GET", "/v1/workflows", `Bearer ${key}`, undefined, { ip: "10.0.0.2" })).statusCode).toBe(200);
    } finally {
      proxy.resume();
      await proxied.close();
      await proxy.close();
    }
  });

  it("counts malformed and missing credentials as failures too", async () => {
    const a = await app({ AUTH_FAILURE_LIMIT: 3 });
    expect((await req(a, "GET", "/v1/workflows")).statusCode).toBe(401);
    expect((await req(a, "GET", "/v1/workflows", "Basic Zm9vOmJhcg==")).statusCode).toBe(401);
    expect((await req(a, "GET", "/v1/workflows", "Bearer not-a-key")).statusCode).toBe(401);
    expect((await req(a, "GET", "/v1/workflows")).statusCode).toBe(429);
  });

  it("ignores X-Forwarded-For by default, so the failure budget cannot be dodged", async () => {
    const a = await app({ AUTH_FAILURE_LIMIT: 2 });
    for (let i = 0; i < 2; i++) await req(a, "GET", "/v1/workflows");
    const spoofed = await req(a, "GET", "/v1/workflows", undefined, undefined, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(spoofed.statusCode).toBe(429);
  });

  it("honours X-Forwarded-For only from trusted proxy hops", async () => {
    const a = await app({ AUTH_FAILURE_LIMIT: 2, TRUST_PROXY: "1" });
    const via = (client: string) => ({ headers: { "x-forwarded-for": client } });
    for (let i = 0; i < 2; i++) await req(a, "GET", "/v1/workflows", undefined, undefined, via("203.0.113.9"));
    expect((await req(a, "GET", "/v1/workflows", undefined, undefined, via("203.0.113.9"))).statusCode).toBe(429);
    expect((await req(a, "GET", "/v1/workflows", undefined, undefined, via("198.51.100.4"))).statusCode).toBe(401);
  });

  it("applies a coarse per-address budget before authentication, except /health", async () => {
    const a = await app({ RATE_LIMIT_IP_PER_MINUTE: 3 });
    for (let i = 0; i < 3; i++) expect((await req(a, "GET", "/ready")).statusCode).toBe(200);
    const r = await req(a, "GET", "/ready");
    expect(r.statusCode).toBe(429);
    expect(r.json().error.details).toEqual({ scope: "ip" });
    for (let i = 0; i < 5; i++) expect((await req(a, "GET", "/health")).statusCode).toBe(200);
    // A query string (cache busting by some probes) does not change the route.
    for (let i = 0; i < 3; i++) expect((await req(a, "GET", `/health?probe=${i}`)).statusCode).toBe(200);
  });
});

describe("S-3: workflow-version reads are paginated and bounded", () => {
  it("returns only the latest definition, and pages version metadata without definitions", async () => {
    const a = await app();
    const { key } = await newTenant("acme");
    for (let i = 1; i <= 25; i++) expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("wf", i))).statusCode).toBe(201);

    const detail = (await req(a, "GET", "/v1/workflows/wf", `Bearer ${key}`)).json();
    expect(detail.latest.version).toBe(25);
    expect(detail.latest.definition.tasks[0].input).toEqual({ n: 25 });
    expect(detail).not.toHaveProperty("versions");

    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: LightMyRequestResponse = await req(a, "GET", `/v1/workflows/wf/versions?limit=10${cursor ? `&cursor=${cursor}` : ""}`, `Bearer ${key}`);
      const body = page.json();
      expect(body.versions.length).toBeLessThanOrEqual(10);
      for (const v of body.versions) {
        expect(v).not.toHaveProperty("definition");
        expect(v.definitionBytes).toBeGreaterThan(0);
        seen.push(v.version);
      }
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));

    const one = (await req(a, "GET", "/v1/workflows/wf/versions/7", `Bearer ${key}`)).json();
    expect(one.version.definition.tasks[0].input).toEqual({ n: 7 });
    expect((await req(a, "GET", "/v1/workflows/wf/versions/99", `Bearer ${key}`)).statusCode).toBe(404);
    expect((await req(a, "GET", "/v1/workflows/wf/versions?cursor=abc", `Bearer ${key}`)).statusCode).toBe(400);
    expect((await req(a, "GET", "/v1/workflows/wf/versions?limit=1000", `Bearer ${key}`)).statusCode).toBe(400);
  });

  it("rejects definitions above the size limit", async () => {
    const a = await app({ DEFINITION_MAX_BYTES: 2_048 });
    const { key } = await newTenant("acme");
    const r = await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, { name: "big", tasks: [{ key: "a", type: "t", input: { pad: "x".repeat(4_000) } }] });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toMatchObject({ code: "definition_too_large", details: { limit: 2_048 } });
  });
});

describe("tenant quotas", () => {
  it("enforces workflow and version-per-workflow quotas (re-registering an identical version is free)", async () => {
    const a = await app();
    const { tenant, key } = await newTenant("acme");
    await setQuota(tenant, { maxWorkflows: 2, maxVersionsPerWorkflow: 3 });
    expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("one"))).statusCode).toBe(201);
    expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("two"))).statusCode).toBe(201);
    const third = await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("three"));
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatchObject({ code: "quota_exceeded", details: { quota: "max_workflows", limit: 2, usage: 2 } });

    for (const n of [1, 2]) expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("one", n))).statusCode).toBe(201);
    expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("one", 3))).json().error.details).toMatchObject({ quota: "max_versions_per_workflow" });
    expect((await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("one", 2))).statusCode).toBe(200);
  });

  it("never admits more active runs than the quota under concurrent submission", async () => {
    const a = await app({ RATE_LIMIT_KEY_PER_MINUTE: 1_000 });
    const { tenant, key } = await newTenant("acme");
    await setQuota(tenant, { maxActiveRuns: 5 });
    await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("wf"));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => req(a, "POST", "/v1/workflows/wf/runs", `Bearer ${key}`, { idempotencyKey: `k${i}` })));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(15);
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int as n from workflow_runs where tenant_id = ${tenant}`;
    expect(row!.n).toBe(5);
    // Replaying an accepted idempotency key returns the run even at the quota.
    const accepted = results.find((r) => r.statusCode === 201)!.json().run;
    const replay = await req(a, "POST", "/v1/workflows/wf/runs", `Bearer ${key}`, { idempotencyKey: accepted.idempotencyKey });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().run.id).toBe(accepted.id);
  });

  it("limits registered workers; deregistering frees a slot", async () => {
    const a = await app();
    const { tenant, key } = await newTenant("acme");
    await setQuota(tenant, { maxActiveWorkers: 2 });
    const reg = () => req(a, "POST", "/v1/workers", `Bearer ${key}`, { name: "w", queues: ["default"], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 256 });
    const w1 = (await reg()).json().workerId;
    expect((await reg()).statusCode).toBe(201);
    expect((await reg()).json().error).toMatchObject({ code: "quota_exceeded", details: { quota: "max_active_workers" } });
    await req(a, "POST", `/v1/workers/${w1}/deregister`, `Bearer ${key}`);
    expect((await reg()).statusCode).toBe(201);
  });

  it("reports limits and usage at GET /v1/tenant", async () => {
    const a = await app();
    const { key } = await newTenant("acme");
    await req(a, "PUT", "/v1/workflows", `Bearer ${key}`, def("wf"));
    await req(a, "POST", "/v1/workflows/wf/runs", `Bearer ${key}`, {});
    const r = (await req(a, "GET", "/v1/tenant", `Bearer ${key}`)).json();
    expect(r.tenant.slug).toBe("acme");
    expect(r.quotas).toMatchObject({ max_workflows: { limit: 200, usage: 1 }, max_active_runs: { limit: 500, usage: 1 }, max_concurrency: { usage: 0 } });
  });
});

describe("atomic tenant concurrency", () => {
  it("never leases more running tasks than max_concurrency, even across concurrent claimers and runs", async () => {
    // Each worker serves its own queue, fed by its own workflow and run, so concurrent
    // claims touch disjoint runs and never serialise on run locks. Only the tenant
    // lock can keep their combined leases within the cap.
    const ctx = makeContext(h, realClock());
    const tenant = await createTenant(h, "acme", 3);
    const workers = [];
    for (let i = 0; i < 6; i++) {
      await registerWorkflow(ctx, tenant, { name: `wf${i}`, tasks: Array.from({ length: 5 }, (_, k) => ({ key: `t${k}`, type: "job", queue: `q${i}` })) });
      await submitRun(ctx, tenant, { workflow: `wf${i}`, triggeredBy: "t" });
      workers.push(await registerWorker(ctx, tenant, { name: `w${i}`, queues: [`q${i}`], capabilities: [], taskTypes: ["job"], maxConcurrency: 10, cpu: 10, memoryMb: 10_000 }));
    }
    const leased = (await Promise.all(workers.map((w) => claimTasks(ctx, w, { freeSlots: 10, freeCpu: 10, freeMemoryMb: 10_000 })))).flat();
    expect(leased).toHaveLength(3);
    const [row] = await h.sql<{ n: number }[]>`select count(*)::int as n from tasks where tenant_id = ${tenant} and state = 'running'`;
    expect(row!.n).toBe(3);
  });
});

describe("aging reaches past a backlog", () => {
  it("leases a long-waiting low-priority task even behind more than a window of higher-priority work", async () => {
    const clock = new TestClock();
    const ctx = makeContext(h, clock);
    const tenant = await createTenant(h, "aging", 1_000);
    await registerWorkflow(ctx, tenant, { name: "low", tasks: [{ key: "a", type: "job", priority: 0 }] });
    await registerWorkflow(ctx, tenant, { name: "high", tasks: [{ key: "a", type: "job", priority: 5 }] });
    const low = (await submitRun(ctx, tenant, { workflow: "low", triggeredBy: "t" })).run.id;
    clock.advance(10 * 60_000); // the low task has waited 10 min: +20 from aging, effective 20
    for (let i = 0; i < 260; i++) await submitRun(ctx, tenant, { workflow: "high", triggeredBy: "t" }); // effective 5
    const w: WorkerRow = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 1, cpu: 8, memoryMb: 8_192 });
    const [lease] = await claimTasks(ctx, w, { freeSlots: 1, freeCpu: 8, freeMemoryMb: 8_192 });
    expect(lease?.runId).toBe(low);
  });
});

describe("cross-tenant fairness and starvation", () => {
  /** Register a one-task workflow, start `runs` runs and lease every task. */
  async function leaseMany(ctx: ReturnType<typeof makeContext>, slug: string, runs: number, retry = false) {
    const tenant = await createTenant(h, slug, 1_000);
    await registerWorkflow(ctx, tenant, {
      name: "one",
      tasks: [
        {
          key: "a",
          type: "job",
          ...(retry ? { retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 1_000, backoffCoefficient: 1, jitter: 0 } } : {}),
        },
      ],
    });
    const runIds: string[] = [];
    for (let i = 0; i < runs; i++) runIds.push((await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" })).run.id);
    const w: WorkerRow = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 256, cpu: 1_000, memoryMb: 1_000_000 });
    const leases = [];
    while (leases.length < runs) {
      const got = await claimTasks(ctx, w, { freeSlots: 256, freeCpu: 1_000, freeMemoryMb: 1_000_000 });
      if (got.length === 0) break;
      leases.push(...got);
    }
    expect(leases).toHaveLength(runs);
    return { tenant, runIds, w, leases };
  }

  const countState = async (tenant: string, state: string) =>
    (await h.sql`select count(*)::int as n from tasks where tenant_id = ${tenant} and state = ${state}::task_state`)[0]!.n as number;

  it("reaps a small tenant's expired lease in the same round as a large tenant's burst", async () => {
    const clock = new TestClock();
    const ctx = makeContext(h, clock);
    const big = await leaseMany(ctx, "big", 150); // these expire first
    clock.advance(1_000);
    const small = await leaseMany(ctx, "small", 1);
    clock.advance(31_000); // every lease has expired
    await reapExpiredLeases(ctx, { maxRounds: 1 }); // one round: 100 rows, at most 20 per tenant
    expect(await countState(small.tenant, "retry_scheduled")).toBe(1);
    expect(await countState(big.tenant, "retry_scheduled")).toBe(20);
    // A lone tenant's backlog still drains at perTenant × maxRounds per tick.
    expect(await reapExpiredLeases(ctx)).toBe(100);
    await reapExpiredLeases(ctx);
    expect(await countState(big.tenant, "running")).toBe(0);
  });

  it("promotes a small tenant's due retry in the same round as a large tenant's burst", async () => {
    const clock = new TestClock();
    const ctx = makeContext(h, clock);
    const big = await leaseMany(ctx, "big", 150, true);
    for (const l of big.leases) await failTask(ctx, { tenantId: big.tenant, taskId: l.taskId, workerId: big.w.id, fence: l.fence, error: { message: "x" } });
    clock.advance(500);
    const small = await leaseMany(ctx, "small", 1, true);
    const l = small.leases[0]!;
    await failTask(ctx, { tenantId: small.tenant, taskId: l.taskId, workerId: small.w.id, fence: l.fence, error: { message: "x" } });
    clock.advance(2_000); // all 151 retries are due; the big tenant's 150 are due first
    await promoteRetries(ctx, { maxRounds: 1 });
    expect(await countState(small.tenant, "queued")).toBe(1);
    expect(await countState(big.tenant, "queued")).toBe(20);
    await promoteRetries(ctx);
    await promoteRetries(ctx);
    expect(await countState(big.tenant, "queued")).toBe(150);
  });

  it("allows one in-flight long-poll per worker: a newer poll ends the older one's wait", async () => {
    const a = await app();
    const { key } = await newTenant("acme");
    const workerId = (await req(a, "POST", "/v1/workers", `Bearer ${key}`, { name: "w", queues: ["default"], taskTypes: ["job"], maxConcurrency: 1, cpu: 1, memoryMb: 256 })).json().workerId;
    const t0 = Date.now();
    const first = req(a, "POST", `/v1/workers/${workerId}/poll`, `Bearer ${key}`, { freeSlots: 1, freeCpu: 1, freeMemoryMb: 256, waitMs: 5_000 });
    await new Promise((r) => setTimeout(r, 150));
    const second = req(a, "POST", `/v1/workers/${workerId}/poll`, `Bearer ${key}`, { freeSlots: 1, freeCpu: 1, freeMemoryMb: 256, waitMs: 200 });
    const r1 = await first;
    expect(r1.json()).toEqual({ tasks: [] });
    expect(Date.now() - t0).toBeLessThan(1_500); // ended early, not after 5 s
    expect((await second).statusCode).toBe(200);
  });
});
