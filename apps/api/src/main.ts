import { connect, migrate } from "@flowforge/db";
import pino from "pino";
import { ConfigError, loadConfig } from "./config.js";
import type { EngineContext } from "./engine/context.js";
import { pruneOutbox, relayOutbox, runMaintenanceOnce } from "./engine/maintenance.js";
import { buildApp } from "./http/app.js";
import { createNotifier } from "./infra/notifier.js";

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

const log = pino({
  level: config.LOG_LEVEL,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
});

await migrate(config.DATABASE_URL);
const handle = connect(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX, applicationName: "flowforge-api" });
const notifier = createNotifier(config.REDIS_URL, log);
const ctx: EngineContext = {
  db: handle.db,
  now: () => new Date(),
  notifier,
  log,
  leaseDurationMs: config.LEASE_DURATION_MS,
  heartbeatIntervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
  workerOfflineAfterMs: config.WORKER_OFFLINE_AFTER_MS,
};

const app = await buildApp({ config, ctx });

/** Run `fn` every `ms` without overlapping executions; errors are logged, never fatal. */
function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, loop: name }, "maintenance loop failed");
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const stops: (() => void)[] = [];
if (config.RUN_MAINTENANCE) {
  stops.push(loop("maintenance", config.MAINTENANCE_INTERVAL_MS, () => runMaintenanceOnce(ctx)));
  stops.push(loop("outbox-relay", 100, () => relayOutbox(ctx)));
  stops.push(loop("outbox-prune", 3_600_000, () => pruneOutbox(ctx)));
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  for (const stop of stops) stop();
  await app.close();
  await notifier.close();
  await handle.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
