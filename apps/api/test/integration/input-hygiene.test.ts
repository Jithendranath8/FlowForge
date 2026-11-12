import { type DbHandle } from "@flowforge/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Text that PostgreSQL cannot store must be refused as the client's mistake (400), never
 * surface as a 500: a NUL character is rejected by both text and jsonb. A 500 here is
 * worse than cosmetic: the SDK retries 5xx, so a handler whose output contains NUL was
 * re-run until its retries ran out, and the dead letter blamed a lost lease.
 */

let h: DbHandle;
let app: FastifyInstance;
let key: string;
let workerKey: string;

const config = { MAX_PAYLOAD_BYTES: 256 * 1024, allowedOrigins: ["http://localhost:3000"], NODE_ENV: "test" as const, LOG_LEVEL: "silent" as const };
const NUL = "\u0000";

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

describe.each([["a NUL character", NUL]])("text PostgreSQL cannot store: %s", (_name, bad) => {
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
