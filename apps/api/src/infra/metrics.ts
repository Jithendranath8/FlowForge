import http from "node:http";
import type { Database } from "@flowforge/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import client from "prom-client";
import type { EventInput } from "../engine/history.js";
import { QUOTAS } from "../engine/quotas.js";
import { RETENTION_CATEGORIES } from "../engine/retention.js";
import type { EngineClock } from "./clock.js";
import type { Notifier } from "./notifier.js";

/*
 * Prometheus metrics (ADR-017).
 *
 * One registry per process, served on a separate listener (METRICS_HOST:METRICS_PORT) so
 * it is never exposed on the public API port. Label values are bounded: routes are
 * Fastify route templates, never raw URLs, and there are no tenant, run or task labels.
 *
 * Engine metrics are derived from the history events every state change already writes
 * (recordEvents is the single choke point), so metrics and history cannot drift apart.
 * They are counted when the event is written inside its transaction; a transaction that
 * then rolls back (a database failure mid-transition) leaves a count that the event
 * history does not have. That is rare and acceptable for operational metrics; the event
 * table remains the audit trail.
 */

export const registry = new client.Registry();
/** Monotonic time of the latest successful state sample (null: none yet). */
let lastStateSampleAt: number | null = null;
/** When this process's state sampler started; null while sampling is switched off. */
let stateSamplerStartedAt: number | null = null;
const reg = { registers: [registry] };

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const TASK_SECONDS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3_600, 14_400];

export const metrics = {
  // ------------------------------------------------------------------ HTTP
  httpRequests: new client.Counter({
    name: "flowforge_http_requests_total",
    help: "HTTP requests by route template and status class.",
    labelNames: ["method", "route", "status_class"] as const,
    ...reg,
  }),
  httpDuration: new client.Histogram({
    name: "flowforge_http_request_duration_seconds",
    help: "HTTP request duration by route template (long-polls included).",
    labelNames: ["method", "route"] as const,
    buckets: SECONDS,
    ...reg,
  }),
  httpErrors: new client.Counter({
    name: "flowforge_http_errors_total",
    help: "Error responses by error code (rate_limited, auth_rate_limited, quota_exceeded, database_timeout, ...).",
    labelNames: ["code"] as const,
    ...reg,
  }),
  quotaRejections: new client.Counter({
    name: "flowforge_quota_rejections_total",
    help: "Requests refused by a tenant quota.",
    labelNames: ["quota"] as const,
    ...reg,
  }),

  // ------------------------------------------------------------------ engine (from history events)
  events: new client.Counter({ name: "flowforge_events_total", help: "History events written, by type.", labelNames: ["type"] as const, ...reg }),
  tasksLeased: new client.Counter({ name: "flowforge_tasks_leased_total", help: "Task attempts leased to workers.", ...reg }),
  queueWait: new client.Histogram({
    name: "flowforge_task_queue_wait_seconds",
    help: "Time from a task becoming queued to its lease (engine clock).",
    buckets: TASK_SECONDS,
    ...reg,
  }),
  attempts: new client.Counter({
    name: "flowforge_task_attempts_total",
    help: "Finished task attempts by outcome.",
    labelNames: ["outcome"] as const,
    ...reg,
  }),
  attemptDuration: new client.Histogram({
    name: "flowforge_task_attempt_duration_seconds",
    help: "Task attempt duration by outcome (lease to completion, engine clock).",
    labelNames: ["outcome"] as const,
    buckets: TASK_SECONDS,
    ...reg,
  }),
  runsStarted: new client.Counter({ name: "flowforge_runs_started_total", help: "Workflow runs created.", ...reg }),
  runsFinished: new client.Counter({
    name: "flowforge_runs_finished_total",
    help: "Workflow runs finished, by final state.",
    labelNames: ["state"] as const,
    ...reg,
  }),
  runDuration: new client.Histogram({
    name: "flowforge_run_duration_seconds",
    help: "Workflow run duration from creation to its final state.",
    labelNames: ["state"] as const,
    buckets: TASK_SECONDS,
    ...reg,
  }),

  // ------------------------------------------------------------------ background work
  loopDuration: new client.Histogram({
    name: "flowforge_background_loop_duration_seconds",
    help: "Duration of one background loop tick.",
    labelNames: ["loop"] as const,
    buckets: SECONDS,
    ...reg,
  }),
  loopErrors: new client.Counter({
    name: "flowforge_background_loop_errors_total",
    help: "Background loop ticks that failed.",
    labelNames: ["loop"] as const,
    ...reg,
  }),
  maintenanceRows: new client.Counter({
    name: "flowforge_maintenance_rows_total",
    help: "Rows changed by maintenance, by action (reaped, promoted, offline, resumed, relayed).",
    labelNames: ["action"] as const,
    ...reg,
  }),
  retentionDeleted: new client.Counter({
    name: "flowforge_retention_deleted_rows_total",
    help: "Rows deleted by retention, by category.",
    labelNames: ["category"] as const,
    ...reg,
  }),
  retentionBacklog: new client.Gauge({
    name: "flowforge_retention_backlog",
    help: "1 if the latest retention pass stopped at its batch limit with aged-out rows left, else 0.",
    ...reg,
  }),

  // ------------------------------------------------------------------ system state (sampled from Postgres)
  tasks: new client.Gauge({ name: "flowforge_tasks", help: "Tasks in non-terminal states.", labelNames: ["state"] as const, ...reg }),
  oldestQueued: new client.Gauge({
    name: "flowforge_oldest_queued_task_age_seconds",
    help: "Age of the longest-waiting queued task (0 when none).",
    ...reg,
  }),
  runsActive: new client.Gauge({ name: "flowforge_runs_active", help: "Workflow runs in state running.", ...reg }),
  outboxPending: new client.Gauge({ name: "flowforge_outbox_unpublished", help: "Outbox rows not yet relayed to Redis.", ...reg }),
  outboxOldest: new client.Gauge({
    name: "flowforge_outbox_oldest_unpublished_age_seconds",
    help: "Age of the oldest unrelayed outbox row (0 when none).",
    ...reg,
  }),
  workers: new client.Gauge({ name: "flowforge_workers", help: "Registered workers by state.", labelNames: ["state"] as const, ...reg }),
  deadLettersOpen: new client.Gauge({ name: "flowforge_dead_letters_open", help: "Unresolved dead letters.", ...reg }),
  stateSampleAge: new client.Gauge({
    name: "flowforge_state_sample_age_seconds",
    help: "Time since the system-state gauges were last sampled successfully, or since sampling started if it never has (-1: sampling switched off).",
    ...reg,
    collect() {
      // -1 only when sampling is switched off. A sampler that has never succeeded counts
      // from its start, so an instance failing since boot still turns stale.
      const since = lastStateSampleAt ?? stateSamplerStartedAt;
      this.set(since === null ? -1 : (performance.now() - since) / 1000);
    },
  }),
  stateSampleErrors: new client.Counter({ name: "flowforge_state_sample_errors_total", help: "Failed system-state samples.", ...reg }),
  sseStreams: new client.Gauge({ name: "flowforge_sse_streams", help: "Open live event streams (GET /v1/stream) in this process.", ...reg }),
};

/**
 * Every label combination that dashboards or alerts depend on is exported at zero from
 * process start. A counter series that first appears at its post-incident value shows no
 * increase to rate() or increase(), so without this the first burst of, say, database
 * timeouts after a restart would never fire FlowForgeDatabaseErrors.
 */
export const KNOWN_LABELS = {
  errorCodes: ["database_timeout", "database_unavailable", "internal", "rate_limited", "auth_rate_limited", "quota_exceeded"],
  outcomes: ["succeeded", "failed", "timed_out", "lease_expired", "cancelled"],
  runStates: ["succeeded", "failed", "cancelled"],
  loops: ["maintenance", "outbox-relay", "retention"],
  maintenanceActions: ["reaped", "promoted", "offline", "resumed", "relayed"],
} as const;

function initializeSeries(): void {
  for (const code of KNOWN_LABELS.errorCodes) metrics.httpErrors.inc({ code }, 0);
  for (const quota of Object.keys(QUOTAS)) metrics.quotaRejections.inc({ quota }, 0);
  for (const outcome of KNOWN_LABELS.outcomes) {
    metrics.attempts.inc({ outcome }, 0);
    metrics.attemptDuration.zero({ outcome });
  }
  for (const state of KNOWN_LABELS.runStates) {
    metrics.runsFinished.inc({ state }, 0);
    metrics.runDuration.zero({ state });
  }
  for (const loop of KNOWN_LABELS.loops) {
    metrics.loopErrors.inc({ loop }, 0);
    metrics.loopDuration.zero({ loop });
  }
  for (const action of KNOWN_LABELS.maintenanceActions) metrics.maintenanceRows.inc({ action }, 0);
  for (const category of RETENTION_CATEGORIES) metrics.retentionDeleted.inc({ category }, 0);
}
initializeSeries();

const OUTCOME_BY_KIND: Record<string, string> = { error: "failed", non_retryable: "failed", timeout: "timed_out", lease_expired: "lease_expired" };

/** Called by recordEvents for every event it writes. Never throws into the engine. */
export function observeEvents(events: readonly EventInput[]): void {
  for (const e of events) {
    try {
      metrics.events.inc({ type: e.type });
      const d = e.data ?? {};
      const num = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : null);
      switch (e.type) {
        case "task.started": {
          metrics.tasksLeased.inc();
          const q = num("queuedMs");
          if (q !== null) metrics.queueWait.observe(q / 1000);
          break;
        }
        case "task.succeeded":
        case "task.retry_scheduled":
        case "task.failed": {
          const outcome = e.type === "task.succeeded" ? "succeeded" : (OUTCOME_BY_KIND[String(d.kind)] ?? "failed");
          metrics.attempts.inc({ outcome });
          const ms = num("durationMs");
          if (ms !== null) metrics.attemptDuration.observe({ outcome }, ms / 1000);
          break;
        }
        case "task.cancelled":
          if (d.from === "running") metrics.attempts.inc({ outcome: "cancelled" });
          break;
        case "run.created":
          metrics.runsStarted.inc();
          break;
        case "run.succeeded":
        case "run.failed":
        case "run.cancelled": {
          const state = e.type.slice(4);
          metrics.runsFinished.inc({ state });
          const ms = num("durationMs");
          if (ms !== null) metrics.runDuration.observe({ state }, ms / 1000);
          break;
        }
      }
    } catch {
      // Metrics are best-effort; a bad label must never fail a state transition.
    }
  }
}

/** Gauges read from in-process state when Prometheus scrapes. */
export function registerRuntimeGauges(src: {
  db: () => { size: number; inUse: number; queued: number };
  notifier: Notifier;
  clock: EngineClock;
}): void {
  for (const name of registry.getMetricsAsArray().map((m) => m.name)) {
    if (name.startsWith("flowforge_db_pool_") || name.startsWith("flowforge_redis_") || name.startsWith("flowforge_clock_")) registry.removeSingleMetric(name);
  }
  const gauge = (name: string, help: string, read: () => number) =>
    new client.Gauge({
      name,
      help,
      ...reg,
      collect() {
        this.set(read());
      },
    });
  gauge("flowforge_db_pool_size", "Database connection permits (pool size).", () => src.db().size);
  gauge("flowforge_db_pool_in_use", "Database connection permits in use.", () => src.db().inUse);
  gauge("flowforge_db_pool_waiting", "Queries waiting for a database connection permit.", () => src.db().queued);
  gauge("flowforge_redis_enabled", "1 if Redis is configured.", () => (src.notifier.enabled ? 1 : 0));
  gauge("flowforge_redis_healthy", "1 if the Redis notifier's latest probes succeeded.", () => (src.notifier.healthy() ? 1 : 0));
  gauge("flowforge_redis_consecutive_failures", "Consecutive failed Redis health probes.", () => src.notifier.health().consecutiveFailures);
  gauge("flowforge_clock_offset_seconds", "Engine clock minus this host's wall clock.", () => src.clock.stats().offsetMs / 1000);
  gauge("flowforge_clock_uncertainty_seconds", "Error bound of the latest engine clock sync.", () => src.clock.stats().uncertaintyMs / 1000);
  gauge("flowforge_clock_since_sync_seconds", "Time since the engine clock last synced (-1 for the local clock).", () => {
    const s = src.clock.stats().sinceSyncMs;
    return s === null ? -1 : s / 1000;
  });
  gauge("flowforge_clock_sync_failures", "Failed engine clock syncs since start.", () => src.clock.stats().syncFailures);
}

/** Process metrics (CPU, memory, event-loop lag, GC, handles) under their standard names. */
export function startProcessMetrics(): void {
  client.collectDefaultMetrics({ register: registry });
}

/**
 * Samples queue depth, active runs, outbox backlog, workers and open dead letters from
 * Postgres every `intervalMs`. Ages are measured on the engine clock. The queries are
 * cheap (partial indexes) but run on every instance that enables the sampler, so large
 * deployments can enable it on a subset (METRICS_STATE_INTERVAL_MS=0 elsewhere).
 */
export function startStateSampler(ctx: { db: Database; now: () => Date; log: Pick<Logger, "warn"> }, intervalMs: number): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  stateSamplerStartedAt = performance.now();
  const tick = () => {
    inFlight = sampleState(ctx)
      .catch((err: unknown) => {
        metrics.stateSampleErrors.inc();
        ctx.log.warn({ err }, "metrics state sample failed");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, 0);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

export async function sampleState(ctx: { db: Database; now: () => Date }): Promise<void> {
  const now = ctx.now().toISOString();
  const [s] = await ctx.db.execute<{
    queued: number;
    running: number;
    retry_scheduled: number;
    oldest_queued_s: number | null;
    runs_active: number;
    outbox_pending: number;
    outbox_oldest_s: number | null;
    dead_letters_open: number;
  }>(sql`select
    (select count(*) from tasks where state = 'queued')::int as queued,
    (select count(*) from tasks where state = 'running')::int as running,
    (select count(*) from tasks where state = 'retry_scheduled')::int as retry_scheduled,
    (select extract(epoch from (${now}::timestamptz - min(enqueued_at)))::float8 from tasks where state = 'queued') as oldest_queued_s,
    (select count(*) from workflow_runs where state = 'running')::int as runs_active,
    (select count(*) from outbox where published_at is null)::int as outbox_pending,
    (select extract(epoch from (${now}::timestamptz - min(created_at)))::float8 from outbox where published_at is null) as outbox_oldest_s,
    (select count(*) from dead_letters where resolved_at is null)::int as dead_letters_open`);
  const workers = await ctx.db.execute<{ state: string; n: number }>(sql`select state::text as state, count(*)::int as n from workers group by state`);
  const r = s!;
  for (const state of ["queued", "running", "retry_scheduled"] as const) metrics.tasks.set({ state }, Number(r[state]));
  metrics.oldestQueued.set(Math.max(0, Number(r.oldest_queued_s ?? 0)));
  metrics.runsActive.set(Number(r.runs_active));
  metrics.outboxPending.set(Number(r.outbox_pending));
  metrics.outboxOldest.set(Math.max(0, Number(r.outbox_oldest_s ?? 0)));
  metrics.deadLettersOpen.set(Number(r.dead_letters_open));
  const byState = new Map([...workers].map((w) => [w.state, Number(w.n)]));
  for (const state of ["active", "draining", "offline"]) metrics.workers.set({ state }, byState.get(state) ?? 0);
  lastStateSampleAt = performance.now();
}

/** Serves GET /metrics (Prometheus text format) and nothing else. */
export async function startMetricsServer(host: string, port: number, log: Pick<Logger, "info" | "error">): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { "content-type": registry.contentType }).end(body),
      (err: unknown) => {
        log.error({ err }, "metrics collection failed");
        res.writeHead(500, { "content-type": "text/plain" }).end("metrics collection failed\n");
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actual = (server.address() as { port: number }).port;
  log.info({ host, port: actual }, "metrics listening");
  return { port: actual, close: () => new Promise((r) => server.close(() => r())) };
}
