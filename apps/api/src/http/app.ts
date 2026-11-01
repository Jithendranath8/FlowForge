import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { EngineContext } from "../engine/context.js";
import { AppError } from "../errors.js";
import { makeAuthenticate, type SessionResolver } from "./auth.js";
import { runRoutes } from "./routes/runs.js";
import { workerRoutes } from "./routes/workers.js";
import { workflowRoutes } from "./routes/workflows.js";

export interface AppDeps {
  config: Pick<Config, "MAX_PAYLOAD_BYTES" | "allowedOrigins" | "NODE_ENV" | "LOG_LEVEL">;
  ctx: EngineContext;
  resolveSession?: SessionResolver;
  /** Extra route registration (auth routes are added here in main). */
  extraRoutes?: (app: FastifyInstance) => Promise<void> | void;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, ctx } = deps;
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    bodyLimit: config.MAX_PAYLOAD_BYTES,
    trustProxy: true,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 1_200,
    timeWindow: "1 minute",
    // Per credential when present, else per client IP. Raw keys are never used as identifiers.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `k:${auth.slice(7, 19)}` : `ip:${req.ip}`;
    },
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

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, "app error");
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: { code: (err.code ?? "bad_request").toLowerCase(), message: err.message, requestId: req.id } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal", message: "Internal server error", requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: "route_not_found", message: `No route ${req.method} ${req.url.split("?")[0]}`, requestId: req.id } }),
  );

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    let database = "ok";
    try {
      await ctx.db.execute(sql`select 1`);
    } catch {
      database = "unavailable";
    }
    const redis = !ctx.notifier.enabled ? "not_configured" : ctx.notifier.healthy() ? "ok" : "degraded";
    // Redis is optional for correctness, so only the database decides readiness.
    return reply.code(database === "ok" ? 200 : 503).send({ database, redis });
  });

  const authenticate = makeAuthenticate(ctx, deps.resolveSession);
  await app.register(
    async (v1) => {
      v1.addHook("onRequest", authenticate);
      workflowRoutes(v1, ctx);
      runRoutes(v1, ctx);
      workerRoutes(v1, ctx);
    },
    { prefix: "/v1" },
  );
  if (deps.extraRoutes) await deps.extraRoutes(app);
  return app;
}
