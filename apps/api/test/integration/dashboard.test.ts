import { schema, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseAllowlist } from "../../src/auth/accounts.js";
import { cookieNames, createSession, type SessionPolicy } from "../../src/auth/sessions.js";
import type { EngineContext } from "../../src/engine/context.js";
import { claimTasks, completeTask, failTask, type WorkerRow } from "../../src/engine/execution.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorker } from "../../src/engine/workers.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp } from "../../src/http/app.js";
import { INLINE_OUTPUT_BYTES } from "../../src/http/routes/runs.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/* The endpoints behind the dashboard: search/sort, bounded run details, keys, members, history, scheduling, throughput. */

const policy: SessionPolicy = { secret: "s".repeat(40), ttlMs: 3_600_000, absoluteTtlMs: 7_200_000, secureCookies: false };
let h: DbHandle;
let clock: TestClock;
let ctx: EngineContext;
let app: FastifyInstance;
let tenant: string;
let w: WorkerRow;

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await app?.close();
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
  await app?.close();
  clock = new TestClock();
  ctx = makeContext(h, clock);
  app = await buildApp({
    config: { MAX_PAYLOAD_BYTES: 2 * 1024 * 1024, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" },
    ctx,
    auth: { appUrl: "http://localhost:3000", providers: new Map(), allowlist: parseAllowlist("@example.com"), policy },
  });
  tenant = await createTenant(h, "acme");
  w = await registerWorker(ctx, tenant, { name: "w", queues: ["default"], capabilities: [], taskTypes: ["job"], maxConcurrency: 10, cpu: 8, memoryMb: 8192 });
});

/** A signed-in member of `tenantId`: cookie + CSRF header. */
async function session(role: "owner" | "admin" | "member" | "viewer", email: string, tenantId = tenant) {
  const [u] = await h.db.insert(schema.users).values({ email, createdAt: clock.now() }).returning();
  await h.db.insert(schema.memberships).values({ tenantId, userId: u!.id, role, createdAt: clock.now() });
  const s = await createSession(h.db, clock.now(), policy, { userId: u!.id, tenantId });
  return { cookie: `${cookieNames(false).session}=${s.token}`, "x-csrf-token": s.csrf };
}
const call = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function runToEnd(output: unknown, opts: { idempotencyKey?: string; fail?: boolean } = {}) {
  const { run } = await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test", ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
  for (;;) {
    const leased = (await claimTasks(ctx, w, { freeSlots: 10, freeCpu: 8, freeMemoryMb: 8192 })).filter((l) => l.runId === run.id);
    if (leased.length === 0) break;
    clock.advance(1_000);
    for (const l of leased) {
      const f = { tenantId: tenant, taskId: l.taskId, workerId: w.id, fence: l.fence };
      if (opts.fail) await failTask(ctx, { ...f, error: { message: "boom", retryable: false } });
      else await completeTask(ctx, { ...f, output });
    }
  }
  return run.id;
}

describe("runs: search, sort, bounded details", () => {
  beforeEach(async () => {
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }, { key: "b", type: "job", dependsOn: ["a"] }] });
  });

  it("searches by run id or idempotency-key prefix (wildcards are literal), and pages in either order", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    const ids: string[] = [];
    for (const k of ["order-1", "order-2", "order_3", "invoice-1"]) {
      ids.push(await runToEnd({ k }, { idempotencyKey: k }));
      clock.advance(60_000);
    }
    const list = async (qs: string) => (await call("GET", `/v1/runs?${qs}`, bearer(key))).json() as { runs: { id: string }[]; nextCursor: string | null };
    expect((await list("q=order")).runs.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect((await list("q=order_")).runs.map((r) => r.id)).toEqual([ids[2]]); // "_" is not a wildcard
    expect((await list("q=%25")).runs).toEqual([]); // nor is "%"
    expect((await list(`q=${ids[3]}`)).runs.map((r) => r.id)).toEqual([ids[3]]);

    const p1 = await list("order=asc&limit=2");
    expect(p1.runs.map((r) => r.id)).toEqual(ids.slice(0, 2));
    const p2 = await list(`order=asc&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.runs.map((r) => r.id)).toEqual(ids.slice(2, 4));
    expect(p2.nextCursor).toBeNull();
  });

  it("leaves large outputs, inputs and checkpoints out of run details; the task endpoint has them", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    const big = { blob: "x".repeat(INLINE_OUTPUT_BYTES + 100) };
    const runId = await runToEnd(big);
    const detail = (await call("GET", `/v1/runs/${runId}`, bearer(key))).json() as { tasks: Record<string, unknown>[] };
    expect(detail.tasks).toHaveLength(2);
    for (const t of detail.tasks) {
      expect(t).toMatchObject({ output: null, outputTruncated: true, outputBytes: expect.any(Number), dependsOn: expect.any(Array) });
      expect(t).not.toHaveProperty("input");
      expect(t).not.toHaveProperty("checkpoint");
    }
    const task = (await call("GET", `/v1/tasks/${detail.tasks[0]!.id as string}`, bearer(key))).json() as { task: { output: unknown }; attempts: Record<string, unknown>[] };
    expect(task.task.output).toEqual(big);
    // Attempts as stored, plus the name of the worker that ran each one.
    expect(task.attempts).toEqual([expect.objectContaining({ attempt: 1, outcome: "succeeded", workerId: w.id, workerName: "w" })]);

    const small = await runToEnd({ ok: true });
    const d2 = (await call("GET", `/v1/runs/${small}`, bearer(key))).json() as { tasks: Record<string, unknown>[] };
    expect(d2.tasks[0]).toMatchObject({ output: { ok: true }, outputTruncated: false });
  });
});

describe("workflow list and overview", () => {
  beforeEach(async () => {
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }, { key: "b", type: "job", dependsOn: ["a"] }] });
  });
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it("counts each workflow's runs and reports its last run, with ISO timestamps", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    await runToEnd({ ok: 1 });
    clock.advance(1_000);
    await runToEnd({ ok: 2 });
    const res = await call("GET", "/v1/workflows", bearer(key));
    const wf = (res.json() as { workflows: Record<string, unknown>[] }).workflows.find((w) => w.name === "wf")!;
    expect(wf).toMatchObject({ runs: 2, lastRunState: "succeeded", lastRunAt: expect.stringMatching(ISO) });
    await registerWorkflow(ctx, tenant, { name: "never-run", tasks: [{ key: "a", type: "job" }] });
    const again = (await call("GET", "/v1/workflows", bearer(key))).json() as { workflows: Record<string, unknown>[] };
    expect(again.workflows.find((w) => w.name === "never-run")).toMatchObject({ runs: 0, lastRunAt: null, lastRunState: null });
  });

  it("run events: 404 for a run that does not exist here, an empty page for one with nothing new", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    const { run } = await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    const missing = await call("GET", "/v1/runs/00000000-0000-4000-8000-000000000000/events", bearer(key));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    const all = (await call("GET", `/v1/runs/${run.id}/events`, bearer(key))).json() as { events: { id: number }[] };
    expect(all.events.length).toBeGreaterThan(0);
    const after = await call("GET", `/v1/runs/${run.id}/events?after=${all.events.at(-1)!.id}`, bearer(key));
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ events: [] });
  });

  it("reports the oldest queued task as an ISO timestamp", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    await submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });
    const o = (await call("GET", "/v1/stats/overview", bearer(key))).json() as { queues: { state: string; oldest: string | null }[] };
    const queued = o.queues.find((q) => q.state === "queued")!;
    expect(queued.oldest).toMatch(ISO);
  });
});

describe("API keys", () => {
  it("owners and admins create, list and revoke keys; the secret is shown once and works until revoked", async () => {
    const owner = await session("owner", "o@example.com");
    const created = await call("POST", "/v1/keys", owner, { name: "ci", scopes: ["read", "runs:write", "read"], expiresInDays: 30 });
    expect(created.statusCode).toBe(201);
    const { key, apiKey } = created.json() as { key: string; apiKey: { id: string; scopes: string[]; prefix: string } };
    expect(apiKey.scopes).toEqual(["read", "runs:write"]);
    expect(key.startsWith(apiKey.prefix)).toBe(true);
    expect((await call("GET", "/v1/runs", bearer(key))).statusCode).toBe(200);

    const listed = (await call("GET", "/v1/keys", owner)).json() as { keys: Record<string, unknown>[] };
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]).toMatchObject({ name: "ci", createdBy: "o@example.com", revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain(key.slice(-20)); // no secret, no hash
    expect(listed.keys[0]).not.toHaveProperty("hash");

    const admin = await session("admin", "a@example.com");
    expect((await call("POST", `/v1/keys/${apiKey.id}/revoke`, admin)).statusCode).toBe(200);
    expect((await call("GET", "/v1/runs", bearer(key))).statusCode).toBe(401);
    expect((await call("POST", `/v1/keys/${apiKey.id}/revoke`, admin)).statusCode).toBe(404); // already revoked
  });

  it("members, viewers and API keys cannot manage keys; other workspaces' keys are invisible", async () => {
    const member = await session("member", "m@example.com");
    expect((await call("GET", "/v1/keys", member)).statusCode).toBe(403);
    expect((await call("POST", "/v1/keys", member, { name: "x", scopes: ["read"] })).statusCode).toBe(403);
    const apiKey = await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]);
    const byKey = await call("POST", "/v1/keys", bearer(apiKey), { name: "escalate", scopes: ["worker"] });
    expect(byKey.statusCode).toBe(403);
    expect(byKey.json().error.message).toMatch(/API keys cannot/);

    const other = await createTenant(h, "other");
    const theirs = await createApiKey(h, other, ["read"]);
    const [row] = await h.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.tenantId, other));
    const owner = await session("owner", "o@example.com");
    expect((await call("POST", `/v1/keys/${row!.id}/revoke`, owner)).statusCode).toBe(404);
    expect((await call("GET", "/v1/runs", bearer(theirs))).statusCode).toBe(200);
    // Only this workspace's own key (created above) is listed, not the other workspace's.
    const mine = ((await call("GET", "/v1/keys", owner)).json() as { keys: { prefix: string }[] }).keys.map((k) => k.prefix);
    expect(mine).toHaveLength(1);
    expect(mine).not.toContain(row!.prefix);
    // Session writes still need the CSRF token.
    const noCsrf = { cookie: owner.cookie };
    expect((await call("POST", "/v1/keys", noCsrf, { name: "x", scopes: ["read"] })).json().error.code).toBe("csrf_failed");
  });
});

describe("members, history, scheduling, throughput", () => {
  beforeEach(async () => {
    await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "job" }, { key: "b", type: "job", dependsOn: ["a"] }] });
  });

  it("lists the workspace's members", async () => {
    const owner = await session("owner", "o@example.com");
    await session("viewer", "v@example.com");
    const other = await createTenant(h, "other");
    await session("owner", "x@example.com", other);
    const members = (await call("GET", "/v1/members", owner)).json() as { members: { email: string; role: string }[] };
    expect(members.members.map((m) => [m.email, m.role])).toEqual([
      ["o@example.com", "owner"],
      ["v@example.com", "viewer"],
    ]);
  });

  it("pages the event history backwards, filtered by type or run", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    const r1 = await runToEnd({});
    await runToEnd({});
    const page = async (qs: string) => (await call("GET", `/v1/events?${qs}`, bearer(key))).json() as { events: { id: number; type: string; runId: string | null }[]; nextBefore: number | null };
    const first = await page("limit=3");
    expect(first.events).toHaveLength(3);
    expect(first.events[0]!.id).toBeGreaterThan(first.events[2]!.id);
    const second = await page(`limit=3&before=${first.nextBefore}`);
    expect(second.events[0]!.id).toBeLessThan(first.events[2]!.id);
    expect((await page("type=run.succeeded")).events.map((e) => e.type)).toEqual(["run.succeeded", "run.succeeded"]);
    expect(new Set((await page(`runId=${r1}&limit=200`)).events.map((e) => e.runId))).toEqual(new Set([r1]));
  });

  it("lists task executions across the workspace, newest first, filtered and paged", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    await runToEnd({});
    clock.advance(60_000);
    await runToEnd({}, { fail: true });
    const list = async (qs: string) => (await call("GET", `/v1/attempts?${qs}`, bearer(key))).json() as { attempts: Record<string, unknown>[]; nextCursor: string | null };
    const all = await list("limit=2");
    expect(all.attempts).toHaveLength(2);
    expect(all.attempts[0]).toMatchObject({ outcome: "failed", taskKey: "a", taskType: "job", workerName: "w", error: expect.objectContaining({ message: "boom" }) });
    const rest = await list(`limit=2&cursor=${all.nextCursor}`);
    // 3 attempts in all: the failed run stopped after a (b was skipped).
    expect(rest.attempts.map((a) => a.outcome)).toEqual(["succeeded"]);
    expect(rest.nextCursor).toBeNull();
    expect((await list("outcome=succeeded")).attempts).toHaveLength(2);
    expect((await list(`workerId=${w.id}&outcome=failed`)).attempts).toHaveLength(1);
  });

  it("shows scheduling decisions and per-type duration statistics", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    await runToEnd({});
    const decisions = (await call("GET", "/v1/scheduling/decisions", bearer(key))).json() as { decisions: Record<string, unknown>[] };
    expect(decisions.decisions).toHaveLength(2);
    expect(decisions.decisions[0]).toMatchObject({ taskKey: "b", taskType: "job", workerName: "w", strategy: "deterministic", advisorUsed: false });
    const stats = (await call("GET", "/v1/scheduling/stats", bearer(key))).json() as { taskTypes: Record<string, unknown>[] };
    expect(stats.taskTypes).toEqual([expect.objectContaining({ taskType: "job", samples: 2, failures: 0, meanDurationMs: 1000 })]);
  });

  it("buckets finished runs and attempts by hour on the engine clock", async () => {
    const key = await createApiKey(h, tenant, ["read"]);
    clock.t = new Date("2026-01-01T10:15:00.000Z");
    await runToEnd({}); // 2 attempts, 1 run, all in the 10:00 hour
    clock.t = new Date("2026-01-01T12:30:00.000Z");
    await runToEnd({}, { fail: true }); // a fails, b skipped: 1 failed attempt, 1 failed run at 12:00
    const ts = (await call("GET", "/v1/stats/timeseries?hours=4", bearer(key))).json() as {
      buckets: { start: string; runs: Record<string, number>; attempts: Record<string, number>; succeededDurationMs: { p50: number } | null }[];
    };
    expect(ts.buckets.map((b) => b.start)).toEqual(["2026-01-01T09:00:00.000Z", "2026-01-01T10:00:00.000Z", "2026-01-01T11:00:00.000Z", "2026-01-01T12:00:00.000Z"]);
    expect(ts.buckets.map((b) => [b.runs, b.attempts])).toEqual([
      [{}, {}],
      [{ succeeded: 1 }, { succeeded: 2 }],
      [{}, {}],
      [{ failed: 1 }, { failed: 1 }],
    ]);
    expect(ts.buckets[1]!.succeededDurationMs).toEqual({ p50: 1000, p95: 1000 });
  });
});
