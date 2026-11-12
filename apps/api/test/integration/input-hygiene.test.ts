import { schema, type DbHandle } from "@flowforge/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { MAX_JSON_DEPTH, unstorableText } from "../../src/http/hygiene.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Text that PostgreSQL cannot store must be refused as the client's mistake (400), never
 * surface as a 500: a NUL character (text and jsonb reject it) and a lone UTF-16
 * surrogate (jsonb rejects it; text silently replaces it). A 500 here is worse than
 * cosmetic: the SDK retries 5xx, so a handler whose output contains NUL was re-run until
 * its retries ran out, and the dead letter blamed a lost lease.
 */

let h: DbHandle;
let app: FastifyInstance;
let key: string;
let workerKey: string;

const config = { MAX_PAYLOAD_BYTES: 256 * 1024, allowedOrigins: ["http://localhost:3000"], NODE_ENV: "test" as const, LOG_LEVEL: "silent" as const };
const NUL = "\u0000";
const LONE = "\ud800";

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
  const clock = new TestClock();
  clock.now = () => new Date();
  app = await buildApp({ config: { ...config, RATE_LIMIT_IP_PER_MINUTE: 0, RATE_LIMIT_KEY_PER_MINUTE: 1_000_000, RATE_LIMIT_TENANT_PER_MINUTE: 1_000_000 }, ctx: makeContext(h, clock) });
  const tenant = await createTenant(h, "acme");
  key = await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]);
  workerKey = await createApiKey(h, tenant, ["worker"]);
});

type Method = "GET" | "POST" | "PUT" | "DELETE";
const call = (method: Method, url: string, k: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers: { authorization: `Bearer ${k}` } });

const definition = { name: "job", tasks: [{ key: "only", type: "noop" }] };
const workerBody = { name: "w", queues: ["default"], taskTypes: ["noop"], maxConcurrency: 4, cpu: 4, memoryMb: 1024 };

/** Register the workflow, start a run and lease its task to a new worker. */
async function leaseOne() {
  await call("PUT", "/v1/workflows", key, definition);
  const run = (await call("POST", "/v1/workflows/job/runs", key, {})).json().run as { id: string };
  const workerId = (await call("POST", "/v1/workers", workerKey, workerBody)).json().workerId as string;
  const polled = await call("POST", `/v1/workers/${workerId}/poll`, workerKey, { freeSlots: 1, freeCpu: 4, freeMemoryMb: 1024, waitMs: 0 });
  const task = polled.json().tasks[0] as { taskId: string; fence: number };
  return { run, workerId, task };
}

const expectRefused = (r: { statusCode: number; json: () => { error: { code: string } } }) => {
  expect(r.statusCode).toBe(400);
  expect(r.json().error.code).toBe("invalid_request");
};

describe.each([
  ["a NUL character", NUL],
  ["a lone surrogate", LONE],
])("text PostgreSQL cannot store: %s", (_name, bad) => {
  it("is refused in a run's input", async () => {
    await call("PUT", "/v1/workflows", key, definition);
    expectRefused(await call("POST", "/v1/workflows/job/runs", key, { input: { s: `a${bad}b` } }));
  });

  it("is refused in an object key of a run's input", async () => {
    await call("PUT", "/v1/workflows", key, definition);
    expectRefused(await call("POST", "/v1/workflows/job/runs", key, { input: { [`k${bad}`]: 1 } }));
  });

  it("is refused in an idempotency key", async () => {
    await call("PUT", "/v1/workflows", key, definition);
    expectRefused(await call("POST", "/v1/workflows/job/runs", key, { idempotencyKey: `k${bad}` }));
  });

  it("is refused in a workflow definition", async () => {
    expectRefused(await call("PUT", "/v1/workflows", key, { ...definition, description: `d${bad}d` }));
    expectRefused(await call("PUT", "/v1/workflows", key, { name: "job", tasks: [{ key: "only", type: "noop", input: { deep: [{ s: bad }] } }] }));
  });

  it("is refused in a worker's name", async () => {
    expectRefused(await call("POST", "/v1/workers", workerKey, { ...workerBody, name: `w${bad}` }));
  });

  it("is refused in a query string", async () => {
    expectRefused(await call("GET", `/v1/runs?q=${encodeURIComponent(`a${NUL}b`)}`, key));
  });

  it("is refused in a task's output, and the lease is still held so the worker can report why", async () => {
    const { run, workerId, task } = await leaseOne();
    expectRefused(await call("POST", `/v1/tasks/${task.taskId}/complete`, workerKey, { workerId, fence: task.fence, output: { text: `binary${bad}ish` } }));
    const failed = await call("POST", `/v1/tasks/${task.taskId}/fail`, workerKey, {
      workerId,
      fence: task.fence,
      error: { message: "The API refused the task's output", code: "output_rejected", retryable: false },
    });
    expect(failed.statusCode).toBe(200);
    const detail = (await call("GET", `/v1/runs/${run.id}`, key)).json();
    expect(detail.run.state).toBe("failed");
    expect(detail.tasks[0]).toMatchObject({ attempts: 1, error: { code: "output_rejected" } });
  });

  it("is refused in a failure report and in a checkpoint", async () => {
    const { workerId, task } = await leaseOne();
    expectRefused(await call("POST", `/v1/tasks/${task.taskId}/fail`, workerKey, { workerId, fence: task.fence, error: { message: `boom${bad}` } }));
    expectRefused(await call("POST", `/v1/tasks/${task.taskId}/checkpoint`, workerKey, { workerId, fence: task.fence, checkpoint: { cursor: bad } }));
  });
});

it("refuses a NUL character in a path parameter", async () => {
  expectRefused(await call("GET", "/v1/workflows/a%00b", key));
  expectRefused(await call("POST", "/v1/workflows/a%00b/runs", key, {}));
});

it("refuses JSON nested deeper than the limit instead of overflowing the stack", async () => {
  await call("PUT", "/v1/workflows", key, definition);
  const nested = (depth: number) => `{"input":{"a":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
  const send = (payload: string) => app.inject({ method: "POST", url: "/v1/workflows/job/runs", payload, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
  const deep = await send(nested(100_000));
  expectRefused(deep);
  expect(deep.json().error.message).toMatch(/nested/);
  expectRefused(await send(nested(MAX_JSON_DEPTH)));
  expect((await send(nested(MAX_JSON_DEPTH - 2))).statusCode).toBe(201); // input -> a -> 98 arrays
});

it("says where the offending text is", async () => {
  await call("PUT", "/v1/workflows", key, definition);
  const r = await call("POST", "/v1/workflows/job/runs", key, { input: { items: [{ ok: 1 }, { note: `x${NUL}` }] } });
  expect(r.json().error.message).toMatch(/body\.input\.items\[1\]\.note/);
  expect(r.json().error.message).toMatch(/NUL/);
});

it("accepts ordinary Unicode, including astral characters and escapes that look alike", async () => {
  await call("PUT", "/v1/workflows", key, definition);
  const input = { emoji: "🚀 ok", rtl: "שלום", zeroDigit: "\\u0000 as six characters", newline: "a\nb\tc" };
  const r = await call("POST", "/v1/workflows/job/runs", key, { input });
  expect(r.statusCode).toBe(201);
  expect(r.json().run.input).toEqual(input);
});

describe("backstop", () => {
  it("recognises PostgreSQL's own refusal of such text, in case a path skips the request check", async () => {
    const tenant = await createTenant(h, "direct");
    const jsonb = await h.db.insert(schema.workflows).values({ tenantId: tenant, name: "x", description: `d${NUL}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(unstorableText(jsonb)).toBe(true);
    const lone = await h.sql`select ${JSON.stringify({ s: LONE })}::jsonb`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(unstorableText(lone)).toBe(true);
    expect(unstorableText(new Error("something else"))).toBe(false);
    const other = await h.sql`select 1/0`.then(
      () => null,
      (e: unknown) => e,
    );
    expect(unstorableText(other)).toBe(false);
  });
});

/*
 * Fuzz: hostile values in every field of every route. Whatever the input, the answer is
 * the client's problem (4xx) or fine (2xx/3xx), never a 5xx. Seeded, so a failure
 * reproduces; the failing request is printed.
 */
describe("fuzz: no request shape produces a 5xx", () => {
  const atoms: unknown[] = [
    NUL, `a${NUL}b`, LONE, "\udc00", `x${LONE}y`, "", " ", "\n", "\r\n", "\t", "\u0001", "\u001f", "\u007f", " ", "﻿", "￿", "🚀", "é".repeat(300),
    "x".repeat(5_000), "'", "\"", "\\", "%", "_", "%00", "' OR 1=1 --", "'; drop table tasks; --", "${x}", "{{x}}", "../..", "a/b", "a?b", "a#b", "null", "true", "-1", "0", "1e400",
    "9".repeat(40), "NaN", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff", "2026-01-01T00:00:00Z", "AAAA", "=", "🧨".repeat(50),
    0, -1, 1.5, 1e308, -0, 2 ** 53, true, false, null, [], {}, [[]], [null], { a: { b: { c: [1, "x", null] } } }, { "": "" }, { __proto__x: 1 }, { [`k${NUL}`]: 1 }, { length: 3 },
    Array.from({ length: 300 }, (_, i) => i), "a".repeat(64), "A", "default", "noop", "job",
  ];
  // mulberry32
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const deep = (depth: number): unknown => {
    let v: unknown = "leaf";
    for (let i = 0; i < depth; i++) v = i % 2 ? [v] : { v };
    return v;
  };

  it("holds for 1,500 mutated requests across the API", async () => {
    const { run, workerId, task } = await leaseOne();
    const next = rng(20261112);
    const pick = () => atoms[Math.floor(next() * atoms.length)];
    const str = () => {
      const a = pick();
      return typeof a === "string" ? a : JSON.stringify(a);
    };
    // encodeURIComponent throws on a lone surrogate; send the bytes a careless client would.
    const enc = (s: string) => {
      try {
        return encodeURIComponent(s);
      } catch {
        return `${encodeURIComponent(s.replace(/[\ud800-\udfff]/g, ""))}%ED%A0%80`;
      }
    };
    const q = (params: Record<string, unknown>) =>
      Object.entries(params)
        .map(([k, v]) => `${enc(k)}=${enc(typeof v === "string" ? v : JSON.stringify(v))}`)
        .join("&");
    const seg = () => enc(str()) || "x";
    /** Replace one random leaf (or key) of a valid body with a hostile value. */
    const mutate = (body: unknown): unknown => {
      if (Array.isArray(body)) {
        if (body.length === 0 || next() < 0.2) return pick();
        const i = Math.floor(next() * body.length);
        return body.map((v, j) => (j === i ? mutate(v) : v));
      }
      if (body && typeof body === "object") {
        const keys = Object.keys(body);
        if (keys.length === 0 || next() < 0.15) return pick();
        const k = keys[Math.floor(next() * keys.length)]!;
        const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
        if (next() < 0.1) copy[str()] = pick();
        else copy[k] = mutate(copy[k]);
        return copy;
      }
      return pick();
    };
    const fenced = { workerId, fence: task.fence };
    const routes: (() => { method: Method; url: string; k: string; payload?: unknown })[] = [
      () => ({ method: "PUT", url: "/v1/workflows", k: key, payload: mutate({ name: "fz", description: "d", defaults: { queue: "default", timeoutMs: 5000 }, maxConcurrency: 4, tasks: [{ key: "a", type: "noop", input: { x: 1 } }, { key: "b", type: "noop", dependsOn: ["a"], retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2, backoffCoefficient: 2, jitter: 0 } }] }) }),
      () => ({ method: "POST", url: `/v1/workflows/${next() < 0.5 ? "job" : seg()}/runs`, k: key, payload: mutate({ input: { a: 1, b: { c: "d" } }, idempotencyKey: "k", priority: 1, version: 1 }) }),
      () => ({ method: "POST", url: "/v1/workflows/job/runs", k: key, payload: { input: deep(1 + Math.floor(next() * 3000)) } }),
      () => ({ method: "GET", url: `/v1/runs?${q({ state: pick(), workflow: pick(), q: pick(), order: pick(), limit: pick(), cursor: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/runs?${q({ [str()]: pick(), q: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/runs/${next() < 0.3 ? run.id : seg()}`, k: key }),
      () => ({ method: "GET", url: `/v1/runs/${run.id}/events?${q({ after: pick(), limit: pick() })}`, k: key }),
      () => ({ method: "POST", url: `/v1/runs/${seg()}/cancel`, k: key, payload: pick() }),
      () => ({ method: "GET", url: `/v1/tasks/${seg()}`, k: key }),
      () => ({ method: "POST", url: `/v1/tasks/${seg()}/retry`, k: key }),
      () => ({ method: "GET", url: `/v1/workflows/${seg()}`, k: key }),
      () => ({ method: "GET", url: `/v1/workflows/${next() < 0.5 ? "job" : seg()}/versions?${q({ limit: pick(), cursor: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/workflows/job/versions/${seg()}`, k: key }),
      () => ({ method: "GET", url: `/v1/events?${q({ before: pick(), type: pick(), runId: pick(), limit: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/attempts?${q({ outcome: pick(), workerId: pick(), cursor: pick(), limit: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/scheduling/decisions?${q({ before: pick(), limit: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/stats/timeseries?${q({ hours: pick() })}`, k: key }),
      () => ({ method: "GET", url: `/v1/stream?${q({ runId: pick(), after: pick() })}`, k: workerKey }), // wrong scope: must be refused, not opened
      () => ({ method: "GET", url: `/v1/workers/${seg()}/attempts`, k: key }),
      () => ({ method: "POST", url: "/v1/workers", k: workerKey, payload: mutate({ ...workerBody, hostname: "h", sdkVersion: "1", capabilities: ["gpu"] }) }),
      () => ({ method: "POST", url: `/v1/workers/${next() < 0.5 ? workerId : seg()}/heartbeat`, k: workerKey, payload: mutate({ draining: false, active: [{ taskId: task.taskId, fence: task.fence }] }) }),
      () => ({ method: "POST", url: `/v1/workers/${next() < 0.5 ? workerId : seg()}/poll`, k: workerKey, payload: mutate({ freeSlots: 0, freeCpu: 1, freeMemoryMb: 64, waitMs: 0 }) }),
      () => ({ method: "POST", url: `/v1/workers/${seg()}/deregister`, k: workerKey }),
      () => ({ method: "POST", url: `/v1/tasks/${next() < 0.7 ? task.taskId : seg()}/checkpoint`, k: workerKey, payload: { ...fenced, checkpoint: next() < 0.5 ? pick() : mutate({ cursor: 1, seen: ["a"] }) } }),
      () => ({ method: "POST", url: `/v1/tasks/${task.taskId}/checkpoint`, k: workerKey, payload: mutate({ ...fenced, checkpoint: { c: 1 } }) }),
      // Completion and failure with a fence that is never current, so the leased task stays leased for the other routes.
      () => ({ method: "POST", url: `/v1/tasks/${task.taskId}/complete`, k: workerKey, payload: { workerId, fence: task.fence + 1, output: next() < 0.5 ? pick() : mutate({ rows: [1, 2], note: "n" }) } }),
      () => ({ method: "POST", url: `/v1/tasks/${task.taskId}/fail`, k: workerKey, payload: { workerId, fence: task.fence + 1, error: mutate({ message: "m", code: "c", retryable: true }) } }),
      () => ({ method: "POST", url: `/v1/tasks/${seg()}/complete`, k: workerKey, payload: mutate({ ...fenced, output: {} }) }),
      () => ({ method: "POST", url: "/v1/keys", k: key, payload: mutate({ name: "n", scopes: ["read"], expiresInDays: 1 }) }),
      () => ({ method: "DELETE", url: `/v1/members/${seg()}`, k: key }),
      () => ({ method: "GET", url: `/auth/${seg()}/start?${q({ returnTo: pick() })}`, k: key }),
    ];
    const failures: string[] = [];
    for (let i = 0; i < 1_500; i++) {
      const r = routes[i % routes.length]!();
      const res = await call(r.method, r.url, r.k, r.payload);
      if (res.statusCode >= 500) failures.push(`${res.statusCode} ${r.method} ${r.url.slice(0, 200)} ${JSON.stringify(r.payload)?.slice(0, 300) ?? ""} -> ${res.body.slice(0, 200)}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect((await call("GET", "/health", key)).statusCode).toBe(200);
  }, 120_000);
});
