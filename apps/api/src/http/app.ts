import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import { classifyDbError } from "@flowforge/db";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { AppError, badRequest, rateLimited } from "../errors.js";
import { EventFeed } from "../infra/feed.js";
import { metrics } from "../infra/metrics.js";
import { registerHttpTracing } from "../infra/tracing.js";
import { hasScope, makeAuthenticate, type SessionResolver } from "./auth.js";
import { findUnstorable } from "./hygiene.js";
import { clientKey, FixedWindowLimiter, parseTrustProxy } from "./limits.js";
import { authRoutes, makeSessionResolver, type AuthRuntime } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { runRoutes } from "./routes/runs.js";
import { streamRoutes, type StreamOptions } from "./routes/stream.js";
import { workerRoutes } from "./routes/workers.js";
import { workflowRoutes } from "./routes/workflows.js";

export interface AppDeps {
  config: Pick<Config, "MAX_PAYLOAD_BYTES" | "allowedOrigins" | "NODE_ENV" | "LOG_LEVEL"> &
    Partial<
      Pick<
        Config,
        | "READY_TIMEOUT_MS"
        | "READY_REQUIRES_REDIS"
        | "TRUST_PROXY"
        | "RATE_LIMIT_IP_PER_MINUTE"
        | "RATE_LIMIT_KEY_PER_MINUTE"
        | "RATE_LIMIT_TENANT_PER_MINUTE"
        | "AUTH_FAILURE_LIMIT"
        | "AUTH_FAILURE_WINDOW_MS"
        | "DEFINITION_MAX_BYTES"
      >
    >;
  ctx: EngineContext;
  /** Dashboard sign-in and sessions (ADR-018). Without it, only API keys authenticate. */
  auth?: AuthRuntime;
  /** Live event streams (ADR-019); built from ctx when omitted. */
  feed?: EventFeed;
  stream?: StreamOptions;
  resolveSession?: SessionResolver;
  /** Extra route registration. */
  extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, ctx } = deps;
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    bodyLimit: config.MAX_PAYLOAD_BYTES,
    // Default false: X-Forwarded-For is ignored unless the deployment says which hops to trust.
    trustProxy: parseTrustProxy(config.TRUST_PROXY ?? "false"),
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cookie);

  const minute = 60_000;
  const limits = {
    authFailures: new FixedWindowLimiter({ limit: config.AUTH_FAILURE_LIMIT ?? 30, windowMs: config.AUTH_FAILURE_WINDOW_MS ?? minute }),
    perCredential: new FixedWindowLimiter({ limit: config.RATE_LIMIT_KEY_PER_MINUTE ?? 1_200, windowMs: minute }),
    perTenant: new FixedWindowLimiter({ limit: config.RATE_LIMIT_TENANT_PER_MINUTE ?? 6_000, windowMs: minute }),
  };
  const ipPerMinute = config.RATE_LIMIT_IP_PER_MINUTE ?? 6_000;
  const perIp = ipPerMinute > 0 ? new FixedWindowLimiter({ limit: ipPerMinute, windowMs: minute }) : null;

  // First: every later hook and handler runs inside the request's server span.
  registerHttpTracing(app);

  // Request metrics by route template (bounded labels; unknown paths are "unmatched").
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    metrics.httpRequests.inc({ method: req.method, route, status_class: `${Math.floor(reply.statusCode / 100)}xx` });
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  // First hook on every request: a coarse per-IP budget that runs before any
  // authentication or database work. /health is exempt (no I/O; used by load balancers).
  app.addHook("onRequest", async (req) => {
    if (!perIp || req.routeOptions.url === "/health") return; // the route, so /health?x is exempt too
    const r = perIp.hit(clientKey(req.ip));
    if (!r.allowed) throw rateLimited("rate_limited", "Rate limit exceeded for this client address", r.resetMs, { scope: "ip" });
  });

  // CORS: credentialed requests are only accepted from allowlisted origins. The web app
  // normally proxies /api so requests are same-origin and this does not apply.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    if (!config.allowedOrigins.includes(origin)) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new AppError(403, "origin_not_allowed", "Origin not allowed");
      return;
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Vary", "Origin");
    if (req.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
      reply.header("Access-Control-Allow-Headers", "content-type,authorization,x-csrf-token");
      return reply.code(204).send();
    }
  });

  // Text PostgreSQL cannot store is refused here (after authentication and body parsing),
  // so it can never reach a query and come back as a 500.
  app.addHook("preValidation", async (req) => {
    const problem = findUnstorable(req.params, "path") ?? findUnstorable(req.query, "query") ?? findUnstorable(req.body, "body");
    if (problem) throw badRequest(`Request ${problem}`);
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      metrics.httpErrors.inc({ code: err.code });
      if (err.code === "quota_exceeded") metrics.quotaRejections.inc({ quota: String((err.details as { quota?: unknown } | undefined)?.quota ?? "unknown") });
      if (err.status >= 500) req.log.error({ err }, "app error");
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    // Dependency failures are the server's problem, but they are not bugs: answer 503 so
    // clients and load balancers retry instead of treating it as a hard failure.
    const db = classifyDbError(err);
    if (db) {
      req.log.warn({ err }, `database ${db}`);
      metrics.httpErrors.inc({ code: db === "timeout" ? "database_timeout" : "database_unavailable" });
      return reply
        .code(503)
        .header("retry-after", "1")
        .send({ error: { code: db === "timeout" ? "database_timeout" : "database_unavailable", message: "Database temporarily unavailable", requestId: req.id } });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      metrics.httpErrors.inc({ code: (err.code ?? "bad_request").toLowerCase() });
      return reply.code(status).send({ error: { code: (err.code ?? "bad_request").toLowerCase(), message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    metrics.httpErrors.inc({ code: "internal" });
    return reply.code(500).send({ error: { code: "internal", message: "Internal server error", requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => {
    metrics.httpErrors.inc({ code: "route_not_found" });
    return reply.code(404).send({ error: { code: "route_not_found", message: `No route ${req.method} ${req.url.split("?")[0]}`, requestId: req.id } });
  });

  app.get("/health", async () => ({ status: "ok" }));
  const readyTimeoutMs = config.READY_TIMEOUT_MS ?? 2_000;
  const readyRequiresRedis = config.READY_REQUIRES_REDIS ?? false;
  /**
   * Readiness answers within READY_TIMEOUT_MS no matter what a dependency does: the DB
   * probe races a deadline, and Redis health comes from the notifier's background
   * prober (no network call here). The database decides readiness; Redis only does if
   * READY_REQUIRES_REDIS is set, because the engine degrades to polling without it.
   */
  // The reason Redis is degraded goes to the log (once per new message), never to the
  // response: /ready is unauthenticated and reachable as /api/ready through the web app.
  let loggedRedisError: string | null = null;
  app.get("/ready", async (req, reply) => {
    let timer: NodeJS.Timeout | undefined;
    const database = await Promise.race([
      ctx.db.execute(sql`select 1`).then(
        () => "ok" as const,
        (err: unknown) => (classifyDbError(err) === "timeout" ? ("timeout" as const) : ("unavailable" as const)),
      ),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), readyTimeoutMs))),
    ]).finally(() => clearTimeout(timer));
    const redis = ctx.notifier.health();
    const ready = database === "ok" && (redis.status !== "degraded" || !readyRequiresRedis);
    if (redis.status === "degraded" && redis.lastError !== loggedRedisError) {
      loggedRedisError = redis.lastError;
      req.log.warn({ redis: { lastOkAt: redis.lastOkAt, lastError: redis.lastError } }, "readiness: redis degraded");
    }
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      database,
      redis: redis.status,
      ...(redis.status === "degraded" ? { redisDetail: { lastOkAt: redis.lastOkAt } } : {}),
    });
  });

  const feed = deps.feed ?? new EventFeed(ctx);
  app.addHook("onClose", async () => {
    if (!deps.feed) feed.close();
  });
  const sessions = deps.auth ? makeSessionResolver(ctx, deps.auth) : undefined;
  if (deps.auth && sessions) {
    const auth = deps.auth;
    await app.register(async (a) => authRoutes(a, ctx, auth, sessions));
  }
  const authenticate = makeAuthenticate(ctx, limits, deps.resolveSession ?? sessions);
  // Open streams re-run the same credential checks (no rate limits, no failure counting).
  const reauthenticate = makeAuthenticate(ctx, undefined, deps.resolveSession ?? sessions);
  const recheckStream = async (req: FastifyRequest, tenantId: string) => {
    try {
      await reauthenticate(req, undefined as unknown as FastifyReply);
      return req.principal?.tenantId === tenantId && hasScope(req.principal, "read");
    } catch {
      return false;
    }
  };
  await app.register(
    async (v1) => {
      v1.addHook("onRequest", authenticate);
      workflowRoutes(v1, ctx, { maxDefinitionBytes: config.DEFINITION_MAX_BYTES });
      runRoutes(v1, ctx);
      workerRoutes(v1, ctx);
      streamRoutes(v1, feed, deps.stream, recheckStream);
      dashboardRoutes(v1, ctx);
    },
    { prefix: "/v1" },
  );
  if (deps.extraRoutes) await deps.extraRoutes(app);
  return app;
}
