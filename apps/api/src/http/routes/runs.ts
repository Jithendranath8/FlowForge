import { schema } from "@flowforge/db";
import { and, asc, desc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../engine/context.js";
import { cancelRun, retryTask, submitRun } from "../../engine/runs.js";
import { notFound } from "../../errors.js";
import { requireScope } from "../auth.js";
import { EventsQuery, IdParams, ListRunsQuery, NameParams, SubmitRunBody, decodeCursor, encodeCursor, parse } from "../validation.js";

export function runRoutes(app: FastifyInstance, ctx: EngineContext) {
  app.post("/workflows/:name/runs", async (req, reply) => {
    const p = requireScope(req, "runs:write");
    const { name } = parse(NameParams, req.params);
    const body = parse(SubmitRunBody, req.body ?? {});
    const { run, created } = await submitRun(ctx, p.tenantId, { workflow: name, ...body, triggeredBy: p.label });
    return reply.code(created ? 201 : 200).send({ run, created });
  });

  app.get("/runs", async (req) => {
    const p = requireScope(req, "read");
    const q = parse(ListRunsQuery, req.query);
    const r = schema.workflowRuns;
    const conds: SQL[] = [eq(r.tenantId, p.tenantId)];
    if (q.state) conds.push(eq(r.state, q.state));
    if (q.workflow) conds.push(eq(schema.workflows.name, q.workflow));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      conds.push(or(lt(r.createdAt, c.createdAt), and(eq(r.createdAt, c.createdAt), lt(r.id, c.id)))!);
    }
    const rows = await ctx.db
      .select({
        id: r.id,
        state: r.state,
        workflow: schema.workflows.name,
        version: schema.workflowVersions.version,
        priority: r.priority,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        triggeredBy: r.triggeredBy,
        idempotencyKey: r.idempotencyKey,
      })
      .from(r)
      .innerJoin(schema.workflows, eq(schema.workflows.id, r.workflowId))
      .innerJoin(schema.workflowVersions, eq(schema.workflowVersions.id, r.workflowVersionId))
      .where(and(...conds))
      .orderBy(desc(r.createdAt), desc(r.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { runs: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null };
  });

  app.get("/runs/:id", async (req) => {
    const p = requireScope(req, "read");
    const { id } = parse(IdParams, req.params);
    const [run] = await ctx.db
      .select({ run: schema.workflowRuns, workflow: schema.workflows.name, version: schema.workflowVersions.version })
      .from(schema.workflowRuns)
      .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowRuns.workflowId))
      .innerJoin(schema.workflowVersions, eq(schema.workflowVersions.id, schema.workflowRuns.workflowVersionId))
      .where(and(eq(schema.workflowRuns.tenantId, p.tenantId), eq(schema.workflowRuns.id, id)));
    if (!run) throw notFound("Run");
    const tasks = await ctx.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.tenantId, p.tenantId), eq(schema.tasks.runId, id)))
      .orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.key));
    return { run: { ...run.run, workflow: run.workflow, version: run.version }, tasks };
  });

  app.get("/runs/:id/events", async (req) => {
    const p = requireScope(req, "read");
    const { id } = parse(IdParams, req.params);
    const q = parse(EventsQuery, req.query);
    const events = await ctx.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.tenantId, p.tenantId), eq(schema.events.runId, id), gt(schema.events.id, q.after)))
      .orderBy(asc(schema.events.id))
      .limit(q.limit);
    return { events };
  });

  app.post("/runs/:id/cancel", async (req) => {
    const p = requireScope(req, "runs:write");
    const { id } = parse(IdParams, req.params);
    return { run: await cancelRun(ctx, p.tenantId, id, p.label) };
  });

  app.get("/tasks/:id", async (req) => {
    const p = requireScope(req, "read");
    const { id } = parse(IdParams, req.params);
    const [task] = await ctx.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.tenantId, p.tenantId), eq(schema.tasks.id, id)));
    if (!task) throw notFound("Task");
    const attempts = await ctx.db
      .select()
      .from(schema.taskAttempts)
      .where(and(eq(schema.taskAttempts.tenantId, p.tenantId), eq(schema.taskAttempts.taskId, id)))
      .orderBy(asc(schema.taskAttempts.attempt));
    return { task, attempts };
  });

  app.post("/tasks/:id/retry", async (req) => {
    const p = requireScope(req, "runs:write");
    const { id } = parse(IdParams, req.params);
    return { task: await retryTask(ctx, p.tenantId, id, p.label) };
  });

  app.get("/dead-letters", async (req) => {
    const p = requireScope(req, "read");
    const rows = await ctx.db
      .select({
        id: schema.deadLetters.id,
        taskId: schema.deadLetters.taskId,
        runId: schema.deadLetters.runId,
        reason: schema.deadLetters.reason,
        attempts: schema.deadLetters.attempts,
        lastError: schema.deadLetters.lastError,
        createdAt: schema.deadLetters.createdAt,
        taskKey: schema.tasks.key,
        taskType: schema.tasks.type,
      })
      .from(schema.deadLetters)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.deadLetters.taskId))
      .where(and(eq(schema.deadLetters.tenantId, p.tenantId), isNull(schema.deadLetters.resolvedAt)))
      .orderBy(desc(schema.deadLetters.createdAt))
      .limit(200);
    return { deadLetters: rows };
  });
}
