import { connect, migrate } from "@flowforge/db";
import pino from "pino";
import { ConfigError, loadConfig, retentionPolicy } from "./config.js";
import type { EngineContext } from "./engine/context.js";
import { startBackgroundLoops } from "./engine/maintenance.js";
import { buildApp } from "./http/app.js";
import { authRuntimeFromConfig } from "./auth/runtime.js";
import { DatabaseClock, LocalClock, postgresTimeSource, type EngineClock } from "./infra/clock.js";
import { registerRuntimeGauges, startMetricsServer, startProcessMetrics, startStateSampler } from "./infra/metrics.js";
import { createNotifier } from "./infra/notifier.js";
import { logSerializers } from "./infra/logging.js";
import { initTracing, logCorrelation } from "./infra/tracing.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    console.error("See docs/ENVIRONMENT_VARIABLES.md");
    process.exit(1);
  }
  throw err;
}

// Tracing first, so everything after runs with the SDK registered (ADR-017).
const tracing = config.TRACING_ENABLED
  ? initTracing({ serviceName: config.OTEL_SERVICE_NAME, endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT, sampleRatio: config.TRACING_SAMPLE_RATIO })
  : null;

const log = pino({
  level: config.LOG_LEVEL,
  // Every log line written inside a span carries its trace_id and span_id.
  mixin: logCorrelation,
  serializers: logSerializers,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
});

await migrate(config.DATABASE_URL, { log });
const handle = connect(config.DATABASE_URL, {
  max: config.DATABASE_POOL_MAX,
  applicationName: "flowforge-api",
  statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  idleInTransactionTimeoutMs: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  acquireTimeoutMs: config.DATABASE_ACQUIRE_TIMEOUT_MS,
  queryTimeoutMs: config.DATABASE_QUERY_TIMEOUT_MS,
  transactionTimeoutMs: config.DATABASE_TRANSACTION_TIMEOUT_MS,
});
const notifier = createNotifier(config.REDIS_URL, log, {
  commandTimeoutMs: config.REDIS_COMMAND_TIMEOUT_MS,
  healthIntervalMs: config.REDIS_HEALTH_INTERVAL_MS,
});
// One engine clock for every timestamp (ADR-015). Startup fails if it cannot sync.
const clock: EngineClock =
  config.CLOCK_SOURCE === "database"
    ? await DatabaseClock.start(postgresTimeSource(handle.db), { syncIntervalMs: config.CLOCK_SYNC_INTERVAL_MS, log })
    : new LocalClock();
log.info({ clock: clock.stats(), tracing: tracing ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT, sampleRatio: config.TRACING_SAMPLE_RATIO } : false }, "engine clock ready");
const ctx: EngineContext = {
  db: handle.db,
  now: clock.now,
  notifier,
  log,
  leaseDurationMs: config.LEASE_DURATION_MS,
  heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
  workerOfflineAfterMs: config.WORKER_OFFLINE_AFTER_MS,
};

const auth = authRuntimeFromConfig(config);
log.info({ providers: [...auth.providers.keys()], allowlist: { any: auth.allowlist.any, emails: auth.allowlist.emails.size, domains: auth.allowlist.domains.size } }, "dashboard sign-in");
if (auth.providers.size > 0 && !auth.allowlist.any && auth.allowlist.emails.size + auth.allowlist.domains.size === 0) {
  log.warn("AUTH_ALLOWED_EMAILS is empty: nobody can sign in to the dashboard (set it, or AUTH_ALLOW_ANY_EMAIL=true)");
}
if (/^\d+$/.test(config.TRUST_PROXY.trim()) && config.TRUST_PROXY.trim() !== "0") {
  log.warn(
    { trustProxy: config.TRUST_PROXY },
    "TRUST_PROXY is a hop count: it trusts whatever connects, so a client that reaches this port directly can set X-Forwarded-For; list the web servers' addresses instead",
  );
}
const app = await buildApp({ config, ctx, auth });

// Metrics on their own listener, never on the public API port (ADR-017).
startProcessMetrics();
registerRuntimeGauges({ db: handle.stats, notifier, clock });
const metricsServer = config.METRICS_PORT > 0 ? await startMetricsServer(config.METRICS_HOST, config.METRICS_PORT, log) : null;
const sampler = config.METRICS_STATE_INTERVAL_MS > 0 ? startStateSampler(ctx, config.METRICS_STATE_INTERVAL_MS) : null;

const background = config.RUN_MAINTENANCE
  ? startBackgroundLoops(ctx, {
      maintenanceIntervalMs: config.MAINTENANCE_INTERVAL_MS,
      relayIntervalMs: config.OUTBOX_RELAY_INTERVAL_MS,
      retentionIntervalMs: config.RETENTION_INTERVAL_MS,
      retention: retentionPolicy(config),
    })
  : null;

await app.listen({ host: config.API_HOST, port: config.API_PORT });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  await app.close();
  await background?.stop(); // let in-flight ticks finish before closing the pool
  await sampler?.stop();
  await metricsServer?.close();
  await notifier.close();
  clock.stop();
  await handle.close();
  await tracing?.shutdown().catch((err: unknown) => log.warn({ err }, "trace export flush failed"));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
