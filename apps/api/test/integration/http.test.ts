import { type DbHandle } from "@flowforge/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateApiKey, type Scope } from "../../src/auth/tokens.js";
import { buildApp } from "../../src/http/app.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

let h: DbHandle;
let app: FastifyInstance;
let tenant: string;
let keys: Record<string, string>;

const config = { MAX_PAYLOAD_BYTES: 64 * 1024, allowedOrigins: ["http://localhost:3000"], NODE_ENV: "test" as const, LOG_LEVEL: "silent" as const };

const makeKey = (tenantId: string, scopes: Scope[], opts: { revoked?: boolean; expired?: boolean } = {}) => createApiKey(h, tenantId, scopes, opts);

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
  // Real clock: HTTP tests exercise the server as deployed.
  const clock = new TestClock();
  clock.now = () => new Date();
  app = await buildApp({ config, ctx: makeContext(h, clock) });
  tenant = await createTenant(h, "acme");
  keys = {
    admin: await makeKey(tenant, ["read", "workflows:write", "runs:write"]),
    reader: await makeKey(tenant, ["read"]),
    worker: await makeKey(tenant, ["worker"]),
  };
});

const call = (method: "GET" | "POST" | "PUT", url: string, key?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as object, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });

const definition = {
  name: "report",
  tasks: [
    { key: "fetch", type: "report.fetch" },
    { key: "render", type: "report.render", dependsOn: ["fetch"] },
  ],
};

describe("authentication and authorization", () => {
  it("rejects missing, malformed, revoked and expired keys", async () => {
    expect((await call("GET", "/v1/workflows")).statusCode).toBe(401);
    expect((await call("GET", "/v1/workflows", "not-a-key")).statusCode).toBe(401);
    expect((await call("GET", "/v1/workflows", await makeKey(tenant, ["read"], { revoked: true }))).statusCode).toBe(401);
    expect((await call("GET", "/v1/workflows", await makeKey(tenant, ["read"], { expired: true }))).statusCode).toBe(401);
    const forged = generateApiKey().key; // well-formed, never stored
    expect((await call("GET", "/v1/workflows", forged)).statusCode).toBe(401);
  });

  it("enforces scopes", async () => {
    const r = await call("PUT", "/v1/workflows", keys.reader, definition);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
    expect((await call("POST", "/v1/workers", keys.admin, {})).statusCode).toBe(403);
    expect((await call("GET", "/v1/workflows", keys.worker)).statusCode).toBe(403);
  });

  it("returns 404 for other tenants' resources (no existence leak)", async () => {
    await call("PUT", "/v1/workflows", keys.admin, definition);
    const run = (await call("POST", "/v1/workflows/report/runs", keys.admin, {})).json().run;
    const other = await createTenant(h, "other");
    const otherKey = await makeKey(other, ["read", "runs:write"]);
    expect((await call("GET", `/v1/runs/${run.id}`, otherKey)).statusCode).toBe(404);
    expect((await call("POST", `/v1/runs/${run.id}/cancel`, otherKey)).statusCode).toBe(404);
    expect((await call("GET", "/v1/runs", otherKey)).json().runs).toEqual([]);
  });
});

describe("workflow and run API", () => {
  it("registers, submits, lists with pagination and reads events", async () => {
    const reg = await call("PUT", "/v1/workflows", keys.admin, definition);
    expect(reg.statusCode).toBe(201);
    expect((await call("PUT", "/v1/workflows", keys.admin, definition)).statusCode).toBe(200);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/v1/workflows/report/runs", keys.admin, { input: { i } });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().run.id);
    }
    const page1 = (await call("GET", "/v1/runs?limit=2", keys.reader)).json();
    expect(page1.runs).toHaveLength(2);
    const page2 = (await call("GET", `/v1/runs?limit=2&cursor=${page1.nextCursor}`, keys.reader)).json();
    expect(page2.runs).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.runs, ...page2.runs].map((r: { id: string }) => r.id))).toEqual(new Set(ids));

    const detail = (await call("GET", `/v1/runs/${ids[0]}`, keys.reader)).json();
    expect(detail.run.workflow).toBe("report");
    expect(detail.tasks.map((t: { key: string; state: string }) => [t.key, t.state])).toEqual([
      ["fetch", "queued"],
      ["render", "pending"],
    ]);
    const events = (await call("GET", `/v1/runs/${ids[0]}/events`, keys.reader)).json().events;
    expect(events.map((e: { type: string }) => e.type)).toEqual(["run.created", "task.queued"]);
  });

  it("returns structured validation errors without internals", async () => {
    const bad = await call("PUT", "/v1/workflows", keys.admin, { name: "x", tasks: [{ key: "a", type: "t", dependsOn: ["b"] }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: "invalid_workflow", details: { issues: [{ code: "unknown_dependency" }] } });
    const badRun = await call("POST", "/v1/workflows/missing/runs", keys.admin, {});
    expect(badRun.statusCode).toBe(404);
    const badId = await call("GET", "/v1/runs/not-a-uuid", keys.reader);
    expect(badId.statusCode).toBe(400);
    expect(JSON.stringify(badId.json())).not.toMatch(/stack|node_modules/);
  });

  it("rejects oversized payloads", async () => {
    await call("PUT", "/v1/workflows", keys.admin, definition);
    const r = await call("POST", "/v1/workflows/report/runs", keys.admin, { input: { blob: "x".repeat(70 * 1024) } });
    expect(r.statusCode).toBe(413);
  });
});

describe("worker protocol over HTTP", () => {
  it("registers, long-polls, heartbeats and completes a workflow", async () => {
    await call("PUT", "/v1/workflows", keys.admin, definition);
    const run = (await call("POST", "/v1/workflows/report/runs", keys.admin, { input: { month: "2026-01" } })).json().run;

    const reg = await call("POST", "/v1/workers", keys.worker, {
      name: "w1",
      queues: ["default"],
      taskTypes: ["report.fetch", "report.render"],
      maxConcurrency: 4,
      cpu: 2,
      memoryMb: 2048,
    });
    expect(reg.statusCode).toBe(201);
    const { workerId } = reg.json();

    for (const expected of ["fetch", "render"]) {
      const poll = await call("POST", `/v1/workers/${workerId}/poll`, keys.worker, { freeSlots: 4, freeCpu: 2, freeMemoryMb: 2048, waitMs: 0 });
      const [task] = poll.json().tasks;
      expect(task.key).toBe(expected);
      expect(task.runInput).toEqual({ month: "2026-01" });
      const hb = await call("POST", `/v1/workers/${workerId}/heartbeat`, keys.worker, { active: [{ taskId: task.taskId, fence: task.fence }] });
      expect(hb.json().renewed).toHaveLength(1);
      const done = await call("POST", `/v1/tasks/${task.taskId}/complete`, keys.worker, { workerId, fence: task.fence, output: { ok: expected } });
      expect(done.json()).toEqual({ duplicate: false });
    }
    const final = (await call("GET", `/v1/runs/${run.id}`, keys.admin)).json();
    expect(final.run.state).toBe("succeeded");

    const empty = Date.now();
    const idle = await call("POST", `/v1/workers/${workerId}/poll`, keys.worker, { freeSlots: 4, freeCpu: 2, freeMemoryMb: 2048, waitMs: 300 });
    expect(idle.json().tasks).toEqual([]);
    expect(Date.now() - empty).toBeGreaterThanOrEqual(280);

    expect((await call("POST", `/v1/workers/${workerId}/deregister`, keys.worker)).json()).toEqual({ released: 0 });
    const after = await call("POST", `/v1/workers/${workerId}/poll`, keys.worker, { freeSlots: 1, freeCpu: 1, freeMemoryMb: 1, waitMs: 0 });
    expect(after.statusCode).toBe(409);
  });

  it("rejects completion with a wrong fence", async () => {
    await call("PUT", "/v1/workflows", keys.admin, definition);
    await call("POST", "/v1/workflows/report/runs", keys.admin, {});
    const { workerId } = (await call("POST", "/v1/workers", keys.worker, { name: "w", queues: ["default"], taskTypes: ["report.fetch"], maxConcurrency: 1, cpu: 1, memoryMb: 512 })).json();
    const [task] = (await call("POST", `/v1/workers/${workerId}/poll`, keys.worker, { freeSlots: 1, freeCpu: 1, freeMemoryMb: 512 })).json().tasks;
    const r = await call("POST", `/v1/tasks/${task.taskId}/complete`, keys.worker, { workerId, fence: task.fence + 5, output: 1 });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("lease_lost");
  });
});

describe("long-poll over a real socket", () => {
  it("waits for work and is woken when a run is submitted", async () => {
    await call("PUT", "/v1/workflows", keys.admin, definition);
    const { workerId } = (await call("POST", "/v1/workers", keys.worker, { name: "w", queues: ["default"], taskTypes: ["report.fetch"], maxConcurrency: 1, cpu: 1, memoryMb: 512 })).json();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const started = Date.now();
    const polling = fetch(`${address}/v1/workers/${workerId}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.worker}`, "content-type": "application/json" },
      body: JSON.stringify({ freeSlots: 1, freeCpu: 1, freeMemoryMb: 512, waitMs: 5_000 }),
    }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 400));
    await call("POST", "/v1/workflows/report/runs", keys.admin, {});
    const res = await polling;
    const elapsed = Date.now() - started;
    expect(res.tasks).toHaveLength(1);
    // Without Redis the waiter re-checks every FALLBACK_POLL_MS, so pickup is bounded by ~1s.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("operational endpoints", () => {
  it("serves health/readiness and refuses disallowed origins for writes", async () => {
    expect((await call("GET", "/health")).json()).toEqual({ status: "ok" });
    expect((await call("GET", "/ready")).json()).toEqual({ status: "ready", database: "ok", redis: "not_configured" });
    const cross = await call("PUT", "/v1/workflows", keys.admin, definition, { origin: "https://evil.example" });
    expect(cross.statusCode).toBe(403);
    const allowed = await call("GET", "/v1/workflows", keys.reader, undefined, { origin: "http://localhost:3000" });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});
