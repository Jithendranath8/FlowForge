import { z } from "zod";
import type { RetentionPolicy } from "./engine/retention.js";

/**
 * Runtime configuration, validated once at startup. Missing or malformed required
 * variables stop the process with a message naming each problem.
 * Every variable is documented in docs/ENVIRONMENT_VARIABLES.md.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const urlString = z.url({ protocol: /^https?$/ });

/** Data retention (ADR-016). Each age is in days; 0 keeps that data forever. */
const retentionFields = {
  RETENTION_RUNS_DAYS: z.coerce.number().int().min(0).max(36_500).default(30),
  RETENTION_WORKER_EVENTS_DAYS: z.coerce.number().int().min(0).max(36_500).default(30),
  RETENTION_SCHEDULING_DECISIONS_DAYS: z.coerce.number().int().min(0).max(36_500).default(14),
  RETENTION_OFFLINE_WORKERS_DAYS: z.coerce.number().int().min(0).max(36_500).default(7),
  RETENTION_EXPIRED_SESSIONS_DAYS: z.coerce.number().int().min(0).max(36_500).default(1),
  /** Relayed outbox rows, in hours. */
  RETENTION_OUTBOX_HOURS: z.coerce.number().int().min(1).max(8_760).default(24),
  RETENTION_INTERVAL_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
  /** Rows (or runs) deleted per statement, and statements per category per pass. */
  RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
  RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(10_000).default(20),
};

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /** Public URL of the web app; used for OAuth redirects and CORS. */
    APP_URL: urlString.default("http://localhost:3000"),
    /** Public URL of this API as seen by browsers (through the web proxy) and workers. */
    API_URL: urlString.default("http://localhost:4000"),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Server-side statement_timeout sent as a startup parameter; 0 disables. */
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(5_000),
    /** Server-side idle_in_transaction_session_timeout; 0 disables. */
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(15_000),
    /** Client-side: max wait for a pooled connection. */
    DATABASE_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(2_000),
    /** Client-side: deadline for one statement, including network (holds when the server is frozen). */
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(8_000),
    /** Client-side: deadline for a whole transaction. */
    DATABASE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL").optional(),
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(1_000),
    REDIS_HEALTH_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    /** /ready answers within this bound even if a dependency hangs. */
    READY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    /** If true, /ready also fails while Redis is degraded (Redis is optional for correctness). */
    READY_REQUIRES_REDIS: bool.default(false),
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(100),
    /**
     * Which X-Forwarded-For hops to trust: "false" (default: use the socket address),
     * a hop count, or comma-separated proxy addresses/CIDRs. "true" trusts any client.
     */
    TRUST_PROXY: z
      .string()
      .regex(/^(false|true|\d+|[\w:./]+(\s*,\s*[\w:./]+)*)$/, "must be false, true, a hop count, or comma-separated proxy addresses")
      .default("false"),
    /** Requests per minute per client IP, checked before authentication; 0 disables. */
    RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().min(0).max(1_000_000).default(6_000),
    /** Requests per minute per API key, checked after authentication. */
    RATE_LIMIT_KEY_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(1_200),
    /** Requests per minute per tenant across all its keys. */
    RATE_LIMIT_TENANT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(6_000),
    /** Failed authentication attempts per client IP per window before further attempts are refused. */
    AUTH_FAILURE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(30),
    AUTH_FAILURE_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    /** Max size of a workflow definition (canonical JSON bytes). */
    DEFINITION_MAX_BYTES: z.coerce.number().int().min(1_024).max(10 * 1024 * 1024).default(256 * 1024),
    /** 32+ random bytes, used to sign OAuth state cookies. */
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
    /** Sliding session lifetime: a session unused for this long expires. */
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 14),
    /** Hard cap on a session's age, however active. */
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24 * 30),
    /** Who may sign in: comma-separated emails and @domains. Empty: nobody (unless AUTH_ALLOW_ANY_EMAIL). */
    AUTH_ALLOWED_EMAILS: z.string().default(""),
    /** Let any verified email sign in (each gets a private workspace). */
    AUTH_ALLOW_ANY_EMAIL: bool.default(false),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    /** Comma-separated extra origins allowed for credentialed CORS (APP_URL is always allowed). */
    ALLOWED_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    LEASE_DURATION_MS: z.coerce.number().int().min(2_000).max(600_000).default(30_000),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
    /** A worker missing heartbeats for this long is marked offline. */
    WORKER_OFFLINE_AFTER_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).max(10 * 1024 * 1024).default(1024 * 1024),
    RUN_MAINTENANCE: bool.default(true),
    PREDICTIVE_SCHEDULING: bool.default(true),

    /**
     * Engine time source (ADR-015). "database" follows the database server's clock, which
     * all replicas share; "local" uses this host's clock (single instance only).
     */
    CLOCK_SOURCE: z.enum(["database", "local"]).default("database"),
    CLOCK_SYNC_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),

    ...retentionFields,

    /** Prometheus metrics on a separate listener; METRICS_PORT=0 disables it. */
    METRICS_HOST: z.string().default("127.0.0.1"),
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
    /** How often to sample queue/run/outbox gauges from Postgres; 0 disables. */
    METRICS_STATE_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(15_000),

    /** OpenTelemetry tracing, exported over OTLP/HTTP. */
    TRACING_ENABLED: bool.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: urlString.default("http://localhost:4318"),
    OTEL_SERVICE_NAME: z.string().min(1).default("flowforge-api"),
    /** Fraction of new traces sampled (incoming sampled parents are always followed). */
    TRACING_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
  })
  .superRefine((c, ctx) => {
    for (const p of ["GOOGLE", "GITHUB"] as const) {
      const id = c[`${p}_CLIENT_ID`];
      const secret = c[`${p}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({ code: "custom", path: [`${p}_CLIENT_SECRET`], message: `${p}_CLIENT_ID and ${p}_CLIENT_SECRET must be set together` });
      }
    }
    if (c.NODE_ENV === "production" && !c.APP_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must use https in production" });
    }
    if (c.NODE_ENV === "production" && c.TRUST_PROXY === "true") {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY"],
        message: "\"true\" lets any client choose its IP via X-Forwarded-For; use a hop count or proxy addresses in production",
      });
    }
    if (c.DATABASE_STATEMENT_TIMEOUT_MS > 0 && c.DATABASE_QUERY_TIMEOUT_MS <= c.DATABASE_STATEMENT_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_QUERY_TIMEOUT_MS"],
        message: "must exceed DATABASE_STATEMENT_TIMEOUT_MS so a live server cancels slow statements before the client gives up",
      });
    }
    if (c.SESSION_TTL_HOURS > c.SESSION_ABSOLUTE_TTL_HOURS) {
      ctx.addIssue({ code: "custom", path: ["SESSION_TTL_HOURS"], message: "must not exceed SESSION_ABSOLUTE_TTL_HOURS" });
    }
    if (c.DATABASE_TRANSACTION_TIMEOUT_MS < c.DATABASE_QUERY_TIMEOUT_MS) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_TRANSACTION_TIMEOUT_MS"], message: "must be >= DATABASE_QUERY_TIMEOUT_MS" });
    }
    if (c.LEASE_DURATION_MS <= c.WORKER_HEARTBEAT_INTERVAL_MS * 2) {
      ctx.addIssue({
        code: "custom",
        path: ["LEASE_DURATION_MS"],
        message: "must exceed 2x WORKER_HEARTBEAT_INTERVAL_MS so one missed heartbeat does not expire leases",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema> & { allowedOrigins: string[] };

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** The retention policy alone (for `flowforge-admin retention`, which needs no other settings). */
export function loadRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const parsed = z.object(retentionFields).safeParse(env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return retentionPolicy(parsed.data);
}

export function retentionPolicy(c: z.infer<z.ZodObject<typeof retentionFields>>): RetentionPolicy {
  return {
    runsDays: c.RETENTION_RUNS_DAYS,
    workerEventsDays: c.RETENTION_WORKER_EVENTS_DAYS,
    schedulingDecisionsDays: c.RETENTION_SCHEDULING_DECISIONS_DAYS,
    offlineWorkersDays: c.RETENTION_OFFLINE_WORKERS_DAYS,
    expiredSessionsDays: c.RETENTION_EXPIRED_SESSIONS_DAYS,
    outboxHours: c.RETENTION_OUTBOX_HOURS,
    batchSize: c.RETENTION_BATCH_SIZE,
    maxBatches: c.RETENTION_MAX_BATCHES,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`));
  }
  const c = parsed.data;
  const allowedOrigins = [
    new URL(c.APP_URL).origin,
    ...c.ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((o) => new URL(o).origin),
  ];
  return { ...c, allowedOrigins };
}
