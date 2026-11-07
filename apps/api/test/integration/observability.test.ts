import http from "node:http";
import { schema, type DbHandle } from "@flowforge/db";
import { FlowForgeClient } from "@flowforge/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REDIS_TEST_URL, TEST_URL, createApiKey, createTenant, resetData, setupDatabase } from "./harness.js";
import { WorkerPool, startApi, waitUntil, type ApiProcess } from "./process-harness.js";

/*
 * Observability of the built API process: OTLP/HTTP trace export to a collector, trace
 * propagation through real SDK worker processes, and the Prometheus listener.
 * The collector here is a minimal OTLP/HTTP JSON receiver that records what it is sent.
 */

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  service: string;
}

class FakeCollector {
  readonly spans: OtlpSpan[] = [];
  readonly contentTypes = new Set<string>();
  private server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      this.contentTypes.add(String(req.headers["content-type"]));
      if (req.method === "POST" && req.url === "/v1/traces") {
        const body = JSON.parse(raw) as {
          resourceSpans: {
            resource: { attributes: { key: string; value: { stringValue?: string } }[] };
            scopeSpans: { spans: Omit<OtlpSpan, "service">[] }[];
          }[];
        };
        for (const rs of body.resourceSpans) {
          const service = rs.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue ?? "";
          for (const ss of rs.scopeSpans) for (const s of ss.spans) this.spans.push({ ...s, service });
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  url = "";
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

let h: DbHandle;
let pool: WorkerPool;
let api: ApiProcess | undefined;
let collector: FakeCollector;

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await resetData(h);
  pool = new WorkerPool();
  collector = new FakeCollector();
  await collector.start();
});
afterEach(async () => {
  pool.killAll();
  await api?.stop("SIGKILL");
  api = undefined;
  await collector.close();
});

async function runFanWorkflow(a: ApiProcess) {
  const tenant = await createTenant(h, "obs");
  const client = new FlowForgeClient({ apiUrl: a.url, apiKey: await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]) });
  await client.registerWorkflow({
    name: "fan",
    tasks: [
      { key: "split", type: "e2e.step" },
      { key: "p1", type: "e2e.step", dependsOn: ["split"] },
      { key: "p2", type: "e2e.step", dependsOn: ["split"] },
      { key: "merge", type: "e2e.step", dependsOn: ["p1", "p2"] },
    ],
  });
  await pool.start({ apiUrl: a.url, apiKey: await createApiKey(h, tenant, ["worker"]), name: "w1", concurrency: 2 });
  await pool.start({ apiUrl: a.url, apiKey: await createApiKey(h, tenant, ["worker"]), name: "w2", concurrency: 2 });
  const run = await client.startRun("fan");
  const final = await client.waitForRun(run.id, { timeoutMs: 20_000, intervalMs: 100 });
  expect(final.run.state).toBe("succeeded");
  return run.id;
}

const metricValue = (exposition: string, series: string) => {
  const line = exposition.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe("observability of the API process", () => {
  it("exports one trace per run across API requests from several worker processes, and serves metrics on its own port", { timeout: 60_000 }, async () => {
    api = await startApi({
      DATABASE_URL: TEST_URL,
      REDIS_URL: REDIS_TEST_URL,
      TRACING_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_SERVICE_NAME: "flowforge-api-test",
      METRICS_STATE_INTERVAL_MS: "200",
    });
    const runId = await runFanWorkflow(api);

    // Metrics, scraped from the separate listener while the process runs.
    await new Promise((r) => setTimeout(r, 400)); // let the state sampler see the finished run
    const res = await fetch(api.metricsUrl);
    expect(res.status).toBe(200);
    const m = await res.text();
    expect(metricValue(m, 'flowforge_runs_finished_total{state="succeeded"}')).toBe(1);
    expect(metricValue(m, "flowforge_runs_started_total")).toBe(1);
    expect(metricValue(m, "flowforge_tasks_leased_total")).toBe(4);
    expect(metricValue(m, 'flowforge_task_attempts_total{outcome="succeeded"}')).toBe(4);
    expect(metricValue(m, "flowforge_task_queue_wait_seconds_count")).toBe(4);
    expect(metricValue(m, "flowforge_runs_active")).toBe(0);
    // Exported at zero from start, so the first incident is visible to rate() in alerts.
    expect(metricValue(m, 'flowforge_http_errors_total{code="database_timeout"}')).toBe(0);
    expect(metricValue(m, 'flowforge_task_attempts_total{outcome="lease_expired"}')).toBe(0);
    expect(metricValue(m, 'flowforge_workers{state="active"}')).toBe(2);
    expect(metricValue(m, "flowforge_db_pool_size")).toBe(10);
    expect(metricValue(m, "flowforge_redis_healthy")).toBe(1);
    expect(metricValue(m, "flowforge_clock_since_sync_seconds")).toBeGreaterThanOrEqual(0); // database clock in use
    expect(metricValue(m, "flowforge_state_sample_age_seconds")).toBeLessThan(5);
    expect(m).toMatch(/^flowforge_http_requests_total\{method="POST",route="\/v1\/workers\/:id\/poll",status_class="2xx"\} \d+$/m);
    expect(m).toMatch(/^process_cpu_user_seconds_total /m);
    expect(m).toMatch(/^nodejs_eventloop_lag_seconds /m);
    // Not on the public API port.
    expect((await fetch(`${api.url}/metrics`)).status).toBe(404);

    // Graceful shutdown flushes buffered spans to the collector.
    expect((await api.stop("SIGTERM")).code).toBe(0);
    api = undefined;
    const [run] = await h.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    const traceId = run!.traceContext!.split("-")[1]!;
    await waitUntil(() => collector.spans.some((s) => s.traceId === traceId), 5_000, "spans exported");

    expect([...collector.contentTypes]).toEqual(["application/json"]);
    const inRun = collector.spans.filter((s) => s.traceId === traceId);
    expect(new Set(inRun.map((s) => s.service))).toEqual(new Set(["flowforge-api-test"]));
    const count = (name: string) => inRun.filter((s) => s.name === name).length;
    expect(count("POST /v1/workflows/:name/runs")).toBe(1);
    expect(count("flowforge.submit_run")).toBe(1);
    // Every task's completion arrived from a worker process carrying the run's traceparent.
    expect(count("POST /v1/tasks/:id/complete")).toBe(4);
    expect(count("flowforge.complete_task")).toBe(4);
    const submit = inRun.find((s) => s.name === "flowforge.submit_run")!;
    expect(inRun.filter((s) => s.name === "POST /v1/tasks/:id/complete").every((s) => s.parentSpanId === submit.spanId)).toBe(true);
  });

  it("SIGTERM with live event streams open exits promptly and ends the streams", { timeout: 60_000 }, async () => {
    api = await startApi({ DATABASE_URL: TEST_URL, REDIS_URL: REDIS_TEST_URL });
    const tenant = await createTenant(h, "streams");
    const key = await createApiKey(h, tenant, ["read"]);
    const streams = await Promise.all([1, 2, 3].map(() => fetch(`${api!.url}/v1/stream`, { headers: { authorization: `Bearer ${key}` } })));
    expect(streams.map((s) => s.status)).toEqual([200, 200, 200]);
    const ended = streams.map(async (s) => {
      for await (const _chunk of s.body!) {
        // drain until the server ends the stream
      }
    });
    const { code, ms } = await api.stop("SIGTERM");
    api = undefined;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(5_000); // without ending streams on preClose it waited indefinitely
    await Promise.all(ended.map((p) => p.catch(() => undefined)));
  });

  it("stores no trace context and exports nothing when tracing is off", { timeout: 60_000 }, async () => {
    api = await startApi({ DATABASE_URL: TEST_URL, REDIS_URL: REDIS_TEST_URL, OTEL_EXPORTER_OTLP_ENDPOINT: collector.url });
    const runId = await runFanWorkflow(api);
    expect((await api.stop("SIGTERM")).code).toBe(0);
    api = undefined;
    const [run] = await h.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId));
    expect(run!.traceContext).toBeNull();
    expect(collector.spans).toEqual([]);
  });
});
