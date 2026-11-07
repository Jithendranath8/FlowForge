import { schema } from "@flowforge/db";
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AccessError, removeMember } from "../../auth/accounts.js";
import { SCOPES, generateApiKey, type Scope } from "../../auth/tokens.js";
import type { EngineContext } from "../../engine/context.js";
import { conflict, forbidden, notFound } from "../../errors.js";
import { requireRole, requireScope } from "../auth.js";
import { IdParams, decodeCursor, encodeCursor, parse } from "../validation.js";

const MemberParams = z.object({ userId: z.uuid() });

/*
 * Endpoints the dashboard needs beyond the run/workflow/worker APIs: API keys, members,
 * workspace event history, scheduling insight and throughput over time. Every query is
 * scoped to the caller's tenant and bounded.
 */

const CreateKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  /** Days until the key stops working; omitted: no expiry. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const EventsPage = z.object({
  /** Events older than this id (paging backwards from the newest). */
  before: z.coerce.number().int().min(1).optional(),
  type: z.string().max(64).optional(),
  runId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const DecisionsPage = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const Timeseries = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) });

const AttemptsPage = z.object({
  outcome: z.enum(["running", "succeeded", "failed", "timed_out", "lease_expired", "cancelled"]).optional(),
  workerId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function dashboardRoutes(app: FastifyInstance, ctx: EngineContext) {
  // ---------------------------------------------------------------- API keys
  app.get("/keys", async (req) => {
    const p = requireRole(req, ["owner", "admin"]);
    const k = schema.apiKeys;
    const rows = await ctx.db
      .select({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        createdBy: schema.users.email,
      })
      .from(k)
      .leftJoin(schema.users, eq(schema.users.id, k.createdByUserId))
      .where(eq(k.tenantId, p.tenantId))
      .orderBy(desc(k.createdAt))
      .limit(200);
    return { keys: rows };
  });

  app.post("/keys", async (req, reply) => {
    const p = requireRole(req, ["owner", "admin"]);
    const body = parse(CreateKeyBody, req.body);
    const now = ctx.now();
    const generated = generateApiKey();
    const [row] = await ctx.db
      .insert(schema.apiKeys)
      .values({
        tenantId: p.tenantId,
        name: body.name,
        prefix: generated.prefix,
        hash: generated.hash,
        scopes: [...new Set(body.scopes)] as Scope[],
        createdByUserId: p.userId,
        createdAt: now,
        expiresAt: body.expiresInDays ? new Date(now.getTime() + body.expiresInDays * 86_400_000) : null,
      })
      .returning({ id: schema.apiKeys.id, name: schema.apiKeys.name, prefix: schema.apiKeys.prefix, scopes: schema.apiKeys.scopes, expiresAt: schema.apiKeys.expiresAt });
    // The only time the secret is returned: it is stored as a hash.
    return reply.code(201).send({ key: generated.key, apiKey: row });
  });

  app.post("/keys/:id/revoke", async (req) => {
    const p = requireRole(req, ["owner", "admin"]);
    const { id } = parse(IdParams, req.params);
    const [row] = await ctx.db
      .update(schema.apiKeys)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(schema.apiKeys.tenantId, p.tenantId), eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
      .returning({ id: schema.apiKeys.id, revokedAt: schema.apiKeys.revokedAt });
    if (!row) throw notFound("Active API key");
    return { apiKey: row };
  });

  // ---------------------------------------------------------------- members
  app.get("/members", async (req) => {
    const p = requireScope(req, "read");
    const rows = await ctx.db
      .select({ userId: schema.users.id, email: schema.users.email, name: schema.users.name, avatarUrl: schema.users.avatarUrl, role: schema.memberships.role, since: schema.memberships.createdAt })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.tenantId, p.tenantId))
      .orderBy(schema.memberships.createdAt)
      .limit(500);
    return { members: rows };
  });

  /**
   * Remove someone from this workspace (owners and admins; signed-in users only). Admins
   * may remove members and viewers; owners anyone, keeping at least one owner. The
   * removed person's sessions in this workspace end at once.
   */
  app.delete("/members/:userId", async (req, reply) => {
    const p = requireRole(req, ["owner", "admin"]);
    const { userId } = parse(MemberParams, req.params);
    const [target] = await ctx.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.tenantId, p.tenantId), eq(schema.memberships.userId, userId)));
    if (!target) throw notFound("Member");
    if (p.role === "admin" && (target.role === "owner" || target.role === "admin")) throw forbidden("Only owners can remove owners and admins");
    try {
      const r = await removeMember(ctx.db, p.tenantId, userId);
      req.log.info({ tenantId: p.tenantId, userId, role: r.role, sessionsEnded: r.sessionsEnded, by: p.userId }, "member removed");
    } catch (err) {
      if (err instanceof AccessError) throw err.code === "last_owner" ? conflict("last_owner", err.message) : notFound("Member");
      throw err;
    }
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- execution history
  app.get("/events", async (req) => {
    const p = requireScope(req, "read");
    const q = parse(EventsPage, req.query);
    const e = schema.events;
    const conds: SQL[] = [eq(e.tenantId, p.tenantId)];
    if (q.before) conds.push(lt(e.id, q.before));
    if (q.type) conds.push(eq(e.type, q.type));
    if (q.runId) conds.push(eq(e.runId, q.runId));
    const rows = await ctx.db.select().from(e).where(and(...conds)).orderBy(desc(e.id)).limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { events: page, nextBefore: rows.length > q.limit ? page.at(-1)!.id : null };
  });

  // ---------------------------------------------------------------- task executions (attempts)
  app.get("/attempts", async (req) => {
    const p = requireScope(req, "read");
    const q = parse(AttemptsPage, req.query);
    const a = schema.taskAttempts;
    const conds: SQL[] = [eq(a.tenantId, p.tenantId)];
    if (q.outcome) conds.push(eq(a.outcome, q.outcome));
    if (q.workerId) conds.push(eq(a.workerId, q.workerId));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      conds.push(or(lt(a.startedAt, c.createdAt), and(eq(a.startedAt, c.createdAt), lt(a.id, c.id)))!);
    }
    const rows = await ctx.db
      .select({
        id: a.id,
        taskId: a.taskId,
        runId: a.runId,
        attempt: a.attempt,
        outcome: a.outcome,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        durationMs: a.durationMs,
        error: a.error,
        workerId: a.workerId,
        workerName: schema.workers.name,
        taskKey: schema.tasks.key,
        taskType: schema.tasks.type,
      })
      .from(a)
      .leftJoin(schema.tasks, eq(schema.tasks.id, a.taskId))
      .leftJoin(schema.workers, eq(schema.workers.id, a.workerId))
      .where(and(...conds))
      .orderBy(desc(a.startedAt), desc(a.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { attempts: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.startedAt, last.id) : null };
  });

  // ---------------------------------------------------------------- scheduling
  app.get("/scheduling/decisions", async (req) => {
    const p = requireScope(req, "read");
    const q = parse(DecisionsPage, req.query);
    const d = schema.schedulingDecisions;
    const conds: SQL[] = [eq(d.tenantId, p.tenantId)];
    if (q.before) conds.push(lt(d.id, q.before));
    const rows = await ctx.db
      .select({
        id: d.id,
        taskId: d.taskId,
        runId: schema.tasks.runId,
        taskKey: schema.tasks.key,
        taskType: schema.tasks.type,
        workerId: d.workerId,
        workerName: schema.workers.name,
        strategy: d.strategy,
        score: d.score,
        advisorUsed: d.advisorUsed,
        predictedDurationMs: d.predictedDurationMs,
        confidence: d.confidence,
        modelVersion: d.modelVersion,
        createdAt: d.createdAt,
      })
      .from(d)
      .leftJoin(schema.tasks, eq(schema.tasks.id, d.taskId))
      .leftJoin(schema.workers, eq(schema.workers.id, d.workerId))
      .where(and(...conds))
      .orderBy(desc(d.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { decisions: page, nextBefore: rows.length > q.limit ? page.at(-1)!.id : null };
  });

  app.get("/scheduling/stats", async (req) => {
    const p = requireScope(req, "read");
    const s = schema.taskTypeStats;
    const rows = await ctx.db
      .select({
        taskType: s.taskType,
        samples: s.samples,
        failures: s.failures,
        meanDurationMs: s.meanDurationMs,
        stddevDurationMs: sql<number | null>`case when ${s.samples} > 1 then sqrt(${s.m2DurationMs} / (${s.samples} - 1)) end`,
        ewmaDurationMs: s.ewmaDurationMs,
        updatedAt: s.updatedAt,
      })
      .from(s)
      .where(eq(s.tenantId, p.tenantId))
      .orderBy(desc(s.samples))
      .limit(500);
    return { taskTypes: rows };
  });

  // ---------------------------------------------------------------- throughput over time
  app.get("/stats/timeseries", async (req) => {
    const p = requireScope(req, "read");
    const { hours } = parse(Timeseries, req.query);
    const now = ctx.now();
    const end = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const from = new Date(end.getTime() - (hours - 1) * 3_600_000);
    const fromIso = from.toISOString();
    const [runs, attempts] = await Promise.all([
      ctx.db.execute<{ t: number; state: string; n: number }>(sql`
        select (extract(epoch from date_trunc('hour', finished_at)) * 1000)::float8 as t, state::text as state, count(*)::int as n
        from workflow_runs where tenant_id = ${p.tenantId} and finished_at >= ${fromIso}::timestamptz group by 1, 2`),
      ctx.db.execute<{ t: number; outcome: string; n: number; p50: number | null; p95: number | null }>(sql`
        select (extract(epoch from date_trunc('hour', finished_at)) * 1000)::float8 as t, outcome::text as outcome, count(*)::int as n,
               percentile_cont(0.5) within group (order by duration_ms) as p50,
               percentile_cont(0.95) within group (order by duration_ms) as p95
        from task_attempts where tenant_id = ${p.tenantId} and finished_at >= ${fromIso}::timestamptz group by 1, 2`),
    ]);
    const buckets = Array.from({ length: hours }, (_, i) => {
      const t = from.getTime() + i * 3_600_000;
      const runsIn = [...runs].filter((r) => Number(r.t) === t);
      const attemptsIn = [...attempts].filter((a) => Number(a.t) === t);
      const succeeded = attemptsIn.find((a) => a.outcome === "succeeded");
      return {
        start: new Date(t).toISOString(),
        runs: Object.fromEntries(runsIn.map((r) => [r.state, r.n])),
        attempts: Object.fromEntries(attemptsIn.map((a) => [a.outcome, a.n])),
        succeededDurationMs: succeeded ? { p50: succeeded.p50, p95: succeeded.p95 } : null,
      };
    });
    return { hours, generatedAt: now.toISOString(), buckets };
  });
}
