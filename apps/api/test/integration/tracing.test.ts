import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { schema, type DbHandle } from "@flowforge/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { reapExpiredLeases } from "../../src/engine/maintenance.js";
import { AppError } from "../../src/errors.js";
import { buildApp } from "../../src/http/app.js";
import { initTracing, logCorrelation, withSpan, type TracingHandle } from "../../src/infra/tracing.js";
import { TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Tracing with the real OpenTelemetry SDK, exporting to memory. The SDK is registered
 * globally once for this file (each test file runs in its own worker).
 */

const exporter = new InMemorySpanExporter();
let tracing: TracingHandle;
let h: DbHandle;
let clock: TestClock;
let ctx: EngineContext;
let app: FastifyInstance;
let tenant: string;
let keys: { admin: string; worker: string };

beforeAll(async () => {
  tracing = initTracing({ serviceName: "flowforge-test", endpoint: "http://127.0.0.1:1", sampleRatio: 1, exporter });
  h = await setupDatabase();
});
afterAll(async () => {
  await app?.close();
  await h?.close();
  await tracing?.shutdown();
});
beforeEach(async () => {
  await resetData(h);
  await app?.close();
  clock = new TestClock();
  ctx = makeContext(h, clock);
  app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" }, ctx });
  tenant = await createTenant(h, "acme");
  keys = { admin: await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]), worker: await createApiKey(h, tenant, ["worker"]) };
  exporter.reset();
});

const call = async (method: "GET" | "POST" | "PUT", url: string, key: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}`, ...headers } });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
};
const spans = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);
const one = (name: string): ReadableSpan => {
  const found = spans(name);
  expect(found, name).toHaveLength(1);
  return found[0]!;
};
const traceOf = (tp: string) => tp.split("-")[1]!;
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

async function workerWithRun(tasks: { key: string; type: string; dependsOn?: string[] }[]) {
  expect((await call("PUT", "/v1/workflows", keys.admin, { name: "wf", tasks })).status).toBe(201);
  const started = await call("POST", "/v1/workflows/wf/runs", keys.admin, {});
  expect(started.status).toBe(201);
  const runId = (started.body.run as { id: string }).id;
  const reg = await call("POST", "/v1/workers", keys.worker, { name: "w", queues: ["default"], taskTypes: ["job"], maxConcurrency: 4, cpu: 4, memoryMb: 4096 });
  const workerId = reg.body.workerId as string;
  const poll = async () =>
    (await call("POST", `/v1/workers/${workerId}/poll`, keys.worker, { freeSlots: 4, freeCpu: 4, freeMemoryMb: 4096 })).body.tasks as {
      taskId: string;
      fence: number;
      traceparent: string | null;
    }[];
  return { runId, workerId, poll };
}

describe("a workflow run is one trace", () => {
  it("joins submission, worker reports that carry the run's traceparent, and maintenance on the run", async () => {
    const { runId, workerId, poll } = await workerWithRun([
      { key: "a", type: "job" },
      { key: "b", type: "job", dependsOn: ["a"] },
    ]);
    const [run] = await h.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    const runTrace = traceOf(run!.traceContext!);

    // Submission: server span -> submit_run span; the run stores submit_run's context.
    const submitHttp = one("POST /v1/workflows/:name/runs");
    const submit = one("flowforge.submit_run");
    expect(submitHttp.spanContext().traceId).toBe(runTrace);
    expect(parentOf(submit)).toBe(submitHttp.spanContext().spanId);
    expect(run!.traceContext).toBe(`00-${runTrace}-${submit.spanContext().spanId}-01`);
    expect(submit.attributes).toMatchObject({ "flowforge.run_id": runId, "flowforge.workflow": "wf", "flowforge.run.created": true });

    // The lease carries the run's context; the claim (in the poll's own trace) links to it.
    const [a] = await poll();
    expect(a!.traceparent).toBe(run!.traceContext);
    const claim = spans("flowforge.claim_tasks").find((s) => s.attributes["flowforge.tasks.leased"] === 1)!;
    expect(claim.spanContext().traceId).not.toBe(runTrace);
    expect(claim.links.map((l) => l.context.traceId)).toEqual([runTrace]);

    // The worker reports with the run's traceparent: its request joins the run's trace.
    const done = await call("POST", `/v1/tasks/${a!.taskId}/complete`, keys.worker, { workerId, fence: a!.fence, output: {} }, { traceparent: a!.traceparent! });
    expect(done.status).toBe(200);
    const completeHttp = one("POST /v1/tasks/:id/complete");
    const complete = one("flowforge.complete_task");
    expect(completeHttp.spanContext().traceId).toBe(runTrace);
    expect(parentOf(completeHttp)).toBe(submit.spanContext().spanId);
    expect(parentOf(complete)).toBe(completeHttp.spanContext().spanId);
    expect(complete.attributes).toMatchObject({ "flowforge.run_id": runId, "flowforge.task.key": "a", "flowforge.task.attempt": 1, "flowforge.duplicate": false });
    expect(complete.links).toEqual([]); // already in the run's trace

    // Task b's worker dies: the reaper's span is in the run's trace too.
    await poll();
    clock.advance(31_000);
    expect(await reapExpiredLeases(ctx)).toBe(1);
    const reap = one("flowforge.reap_lease");
    expect(reap.spanContext().traceId).toBe(runTrace);
    expect(parentOf(reap)).toBe(submit.spanContext().spanId);
    expect(reap.attributes["flowforge.run_id"]).toBe(runId);
  });

  it("links a report that arrives without the run's traceparent to the run's trace", async () => {
    const { runId, workerId, poll } = await workerWithRun([{ key: "a", type: "job" }]);
    const [run] = await h.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    const [a] = await poll();
    await call("POST", `/v1/tasks/${a!.taskId}/fail`, keys.worker, { workerId, fence: a!.fence, error: { message: "x" } });
    const fail = one("flowforge.fail_task");
    expect(fail.spanContext().traceId).not.toBe(traceOf(run!.traceContext!));
    expect(fail.links.map((l) => l.context.traceId)).toEqual([traceOf(run!.traceContext!)]);
    expect(fail.attributes).toMatchObject({ "flowforge.will_retry": true });
  });
});

describe("HTTP server spans", () => {
  it("are named by route template, follow an incoming traceparent, and record the status", async () => {
    const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await call("GET", "/v1/runs/00000000-0000-4000-8000-000000000000", keys.admin, undefined, { traceparent: parent });
    expect(res.status).toBe(404);
    const s = one("GET /v1/runs/:id");
    expect(s.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parentOf(s)).toBe("b7ad6b7169203331");
    expect(s.attributes).toMatchObject({ "http.route": "/v1/runs/:id", "http.response.status_code": 404, "url.path": "/v1/runs/00000000-0000-4000-8000-000000000000" });
    expect(s.status.code).toBe(SpanStatusCode.UNSET); // a 404 is not a server failure

    await app.inject({ method: "GET", url: "/no/such/path" });
    expect(one("GET unmatched").attributes["http.response.status_code"]).toBe(404);
  });
});

describe("withSpan", () => {
  it("records expected 4xx errors as an attribute and anything else as a span error", async () => {
    await expect(withSpan("expected", {}, async () => Promise.reject(new AppError(409, "lease_lost", "gone")))).rejects.toThrow("gone");
    await expect(withSpan("unexpected", {}, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const expected = one("expected");
    expect(expected.status.code).toBe(SpanStatusCode.UNSET);
    expect(expected.attributes["flowforge.error.code"]).toBe("lease_lost");
    const unexpected = one("unexpected");
    expect(unexpected.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "boom" });
    expect(unexpected.events.map((e) => e.name)).toEqual(["exception"]);
  });

  it("never exports a failed query's parameters (tenant data) in span exceptions", async () => {
    const secret = "SECRET-TASK-OUTPUT-7f3a";
    const failing = () =>
      h.db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = 50`);
        await tx.execute(sql`select pg_sleep(1), ${secret}::text`);
      });
    await expect(withSpan("db.failure", {}, failing)).rejects.toThrow();
    const s = one("db.failure");
    const exported = JSON.stringify({ status: s.status, events: s.events });
    expect(exported).not.toContain(secret);
    expect(exported).toContain("params: [redacted]");
    expect(exported).toContain("statement timeout"); // the database's own message is kept
  });

  it("exposes the active trace and span ids for log correlation", async () => {
    expect(logCorrelation()).toEqual({});
    const ids = await withSpan("logged", {}, async (span) => ({ inside: logCorrelation(), span: span.spanContext() }));
    expect(ids.inside).toEqual({ trace_id: ids.span.traceId, span_id: ids.span.spanId });
  });
});
