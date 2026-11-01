import { z } from "zod";

/**
 * Runtime configuration, validated once at startup. Missing or malformed required
 * variables stop the process with a message naming each problem.
 * Every variable is documented in docs/ENVIRONMENT_VARIABLES.md.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const urlString = z.url({ protocol: /^https?$/ });

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
    REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL").optional(),
    /** 32+ random bytes, used to sign OAuth state cookies. */
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 14),
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
