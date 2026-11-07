import { schema } from "@flowforge/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../engine/context.js";
import { claimTasks, completeTask, failTask, renewLeases, saveCheckpoint, type LeasedTask } from "../../engine/execution.js";
import { deregisterWorker, registerWorker, touchWorker } from "../../engine/workers.js";
import { requireScope } from "../auth.js";
import { CheckpointBody, CompleteBody, FailBody, HeartbeatBody, IdParams, PollBody, RegisterWorkerBody, parse } from "../validation.js";

/** Worker protocol. Requires an API key with the `worker` scope; everything is tenant-bound. */
export function workerRoutes(app: FastifyInstance, ctx: EngineContext) {
  const activePolls = new Map<string, AbortController>();

  app.post("/workers", async (req, reply) => {
    const p = requireScope(req, "worker");
    const body = parse(RegisterWorkerBody, req.body);
    const w = await registerWorker(ctx, p.tenantId, body);
    return reply.code(201).send({
      workerId: w.id,
      leaseDurationMs: ctx.leaseDurationMs,
      heartbeatIntervalMs: ctx.heartbeatIntervalMs,
    });
  });

  app.post("/workers/:id/heartbeat", async (req) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    const body = parse(HeartbeatBody, req.body ?? {});
    await touchWorker(ctx, p.tenantId, id, body.draining);
    return renewLeases(ctx, p.tenantId, id, body.active);
  });

  /**
   * Long-poll for work. Tries to claim; if nothing is runnable, waits for a Redis
   * wake-up on the worker's queues (or a short fallback interval) until waitMs elapses
   * or the client disconnects.
   */
  app.post("/workers/:id/poll", async (req, reply) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    const body = parse(PollBody, req.body);
    const deadline = performance.now() + body.waitMs; // a duration: monotonic, immune to clock steps
    const abort = new AbortController();
    // The *response* closing before we have written it means the client went away.
    // (IncomingMessage "close" fires as soon as the body is consumed, so it cannot be used.)
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    // One in-flight poll per worker id: a newer poll ends the older one's wait. This
    // bounds a tenant's concurrent long-polls (and, with Redis down, their once-a-second
    // claim attempts) by its max_active_workers quota instead of its request budget.
    const pollKey = `${p.tenantId}:${id}`;
    activePolls.get(pollKey)?.abort();
    activePolls.set(pollKey, abort);
    let tasks: LeasedTask[];
    try {
      for (;;) {
        const worker = await touchWorker(ctx, p.tenantId, id, false);
        tasks = await claimTasks(ctx, worker, body);
        const remaining = deadline - performance.now();
        if (tasks.length > 0 || remaining <= 0 || abort.signal.aborted) break;
        await ctx.notifier.waitForWork(p.tenantId, worker.queues, remaining, abort.signal);
      }
    } finally {
      if (activePolls.get(pollKey) === abort) activePolls.delete(pollKey);
    }
    // Deadlines also go out as durations measured on the engine clock at send time, so a
    // worker never compares the engine's timestamps with its own host clock (ADR-015).
    const sentAt = ctx.now().getTime();
    return { tasks: tasks.map((t) => ({ ...t, deadlineInMs: Math.max(0, Date.parse(t.attemptDeadline) - sentAt) })) };
  });

  app.post("/workers/:id/deregister", async (req) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    return deregisterWorker(ctx, p.tenantId, id);
  });

  app.post("/tasks/:id/complete", async (req) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    const body = parse(CompleteBody, req.body);
    return completeTask(ctx, { tenantId: p.tenantId, taskId: id, workerId: body.workerId, fence: body.fence, output: body.output ?? null });
  });

  app.post("/tasks/:id/fail", async (req) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    const body = parse(FailBody, req.body);
    return failTask(ctx, { tenantId: p.tenantId, taskId: id, workerId: body.workerId, fence: body.fence, error: body.error });
  });

  app.post("/tasks/:id/checkpoint", async (req, reply) => {
    const p = requireScope(req, "worker");
    const { id } = parse(IdParams, req.params);
    const body = parse(CheckpointBody, req.body);
    await saveCheckpoint(ctx, { tenantId: p.tenantId, taskId: id, workerId: body.workerId, fence: body.fence, checkpoint: body.checkpoint });
    return reply.code(204).send();
  });

  app.get("/workers", async (req) => {
    const p = requireScope(req, "read");
    const rows = await ctx.db
      .select({
        id: schema.workers.id,
        name: schema.workers.name,
        hostname: schema.workers.hostname,
        sdkVersion: schema.workers.sdkVersion,
        state: schema.workers.state,
        queues: schema.workers.queues,
        capabilities: schema.workers.capabilities,
        taskTypes: schema.workers.taskTypes,
        maxConcurrency: schema.workers.maxConcurrency,
        cpu: schema.workers.cpu,
        memoryMb: schema.workers.memoryMb,
        registeredAt: schema.workers.registeredAt,
        lastHeartbeatAt: schema.workers.lastHeartbeatAt,
        running: sql<number>`(select count(*)::int from tasks t where t.worker_id = ${schema.workers.id} and t.state = 'running')`,
      })
      .from(schema.workers)
      .where(eq(schema.workers.tenantId, p.tenantId))
      .orderBy(sql`case ${schema.workers.state} when 'active' then 0 when 'draining' then 1 else 2 end`, desc(schema.workers.lastHeartbeatAt))
      .limit(200);
    return { workers: rows };
  });

  app.get("/stats/overview", async (req) => {
    const p = requireScope(req, "read");
    const t = p.tenantId;
    const [runs, queues, workers, dlq] = await Promise.all([
      ctx.db.execute<{ state: string; n: number }>(sql`select state, count(*)::int as n from workflow_runs where tenant_id = ${t} group by state`),
      ctx.db.execute<{ queue: string; state: string; n: number; oldest: string | null }>(sql`
        select queue, state, count(*)::int as n, min(enqueued_at) as oldest from tasks
        where tenant_id = ${t} and state in ('queued','running','retry_scheduled') group by queue, state`),
      ctx.db.execute<{ state: string; n: number }>(sql`select state, count(*)::int as n from workers where tenant_id = ${t} group by state`),
      ctx.db.execute<{ n: number }>(sql`select count(*)::int as n from dead_letters where tenant_id = ${t} and resolved_at is null`),
    ]);
    return {
      runs: Object.fromEntries([...runs].map((r) => [r.state, r.n])),
      // Raw SQL returns Postgres's text timestamp; the API speaks ISO 8601.
      queues: [...queues].map((q) => ({ ...q, oldest: q.oldest ? new Date(q.oldest).toISOString() : null })),
      workers: Object.fromEntries([...workers].map((r) => [r.state, r.n])),
      deadLetters: [...dlq][0]?.n ?? 0,
      generatedAt: ctx.now().toISOString(),
    };
  });

  app.get("/workers/:id/attempts", async (req) => {
    const p = requireScope(req, "read");
    const { id } = parse(IdParams, req.params);
    const rows = await ctx.db
      .select()
      .from(schema.taskAttempts)
      .where(and(eq(schema.taskAttempts.tenantId, p.tenantId), eq(schema.taskAttempts.workerId, id)))
      .orderBy(desc(schema.taskAttempts.startedAt))
      .limit(100);
    return { attempts: rows };
  });
}
