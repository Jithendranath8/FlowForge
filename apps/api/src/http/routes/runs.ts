import { schema } from "@flowforge/db";
import { and, asc, desc, eq, getTableColumns, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../engine/context.js";
import { cancelRun, retryTask, submitRun } from "../../engine/runs.js";
import { notFound } from "../../errors.js";
import { requireScope } from "../auth.js";
import { EventsQuery, IdParams, ListRunsQuery, NameParams, SubmitRunBody, Uuid, decodeCursor, encodeCursor, likePrefix, parse } from "../validation.js";

/** Task outputs larger than this are left out of run details (fetch the task instead). */
export const INLINE_OUTPUT_BYTES = 16 * 1024;

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
    if (q.q) conds.push(Uuid.safeParse(q.q).success ? eq(r.id, q.q) : sql`${r.idempotencyKey} like ${likePrefix(q.q)}`);
    const asc_ = q.order === "asc";
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      const [cmp] = asc_ ? [gt] : [lt];
      conds.push(or(cmp(r.createdAt, c.createdAt), and(eq(r.createdAt, c.createdAt), cmp(r.id, c.id)))!);
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
      .orderBy(...(asc_ ? [asc(r.createdAt), asc(r.id)] : [desc(r.createdAt), desc(r.id)]))
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
    // Task summaries: a run can have 500 tasks, each with up to 1 MiB of output, so outputs
    // over INLINE_OUTPUT_BYTES are left out (outputTruncated) and inputs and checkpoints
    // are not included. GET /v1/tasks/:id returns a task's full payloads.
    const t = schema.tasks;
    const tasks = await ctx.db
      .select({
        id: t.id,
        key: t.key,
        type: t.type,
        state: t.state,
        queue: t.queue,
        priority: t.priority,
        triggerRule: t.triggerRule,
        dependsOn: t.dependsOn,
        attempts: t.attempts,
        timeoutMs: t.timeoutMs,
        workerId: t.workerId,
        enqueuedAt: t.enqueuedAt,
        availableAt: t.availableAt,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        leaseExpiresAt: t.leaseExpiresAt,
        error: t.error,
        output: sql<unknown>`case when octet_length(${t.output}::text) <= ${INLINE_OUTPUT_BYTES} then ${t.output} end`,
        outputBytes: sql<number | null>`octet_length(${t.output}::text)`,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(and(eq(t.tenantId, p.tenantId), eq(t.runId, id)))
      .orderBy(asc(t.createdAt), asc(t.key));
    return {
      run: { ...run.run, workflow: run.workflow, version: run.version },
      tasks: tasks.map((x) => ({ ...x, outputTruncated: x.outputBytes !== null && x.outputBytes > INLINE_OUTPUT_BYTES })),
    };
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
    if (events.length === 0) {
      // Empty can mean "nothing new" or "no such run here"; only the second is a 404.
      const [run] = await ctx.db
        .select({ id: schema.workflowRuns.id })
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.tenantId, p.tenantId), eq(schema.workflowRuns.id, id)));
      if (!run) throw notFound("Run");
    }
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
    // Each attempt row as stored, plus the worker's name for display (null once retention removed it).
    const attempts = await ctx.db
      .select({ ...getTableColumns(schema.taskAttempts), workerName: schema.workers.name })
      .from(schema.taskAttempts)
      .leftJoin(schema.workers, and(eq(schema.workers.id, schema.taskAttempts.workerId), eq(schema.workers.tenantId, schema.taskAttempts.tenantId)))
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
