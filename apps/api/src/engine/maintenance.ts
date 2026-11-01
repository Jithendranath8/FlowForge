import { isLeaseExpired, type FailureKind } from "@flowforge/core";
import { schema } from "@flowforge/db";
import { and, asc, eq, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { EngineContext } from "./context.js";
import { failAttempt } from "./execution.js";
import { recordEvents } from "./history.js";
import { advanceRun, lockRun } from "./runs.js";

/*
 * Background maintenance. Every function is idempotent and safe to run concurrently on
 * several API instances: each state change happens under run+task row locks and
 * re-checks its precondition after locking.
 */

const BATCH = 100;

/** Expired leases (crashed / partitioned workers) and attempts past their deadline. */
export async function reapExpiredLeases(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  const expired = await ctx.db
    .select({ id: schema.tasks.id, tenantId: schema.tasks.tenantId, runId: schema.tasks.runId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.state, "running"), lte(schema.tasks.leaseExpiresAt, now)))
    .orderBy(asc(schema.tasks.leaseExpiresAt))
    .limit(BATCH);
  let reaped = 0;
  for (const e of expired) {
    await ctx.db.transaction(async (tx) => {
      const run = await lockRun(tx, e.tenantId, e.runId);
      const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, e.id)).for("update");
      if (!run || !task || task.state !== "running" || !isLeaseExpired(task.leaseExpiresAt, now)) return;
      const timedOut = task.attemptDeadline !== null && task.attemptDeadline.getTime() <= now.getTime();
      const kind: FailureKind = timedOut ? "timeout" : "lease_expired";
      await failAttempt(
        tx,
        run,
        task,
        kind,
        { message: timedOut ? `Attempt exceeded timeout of ${task.timeoutMs}ms` : "Worker lease expired without heartbeat", code: kind },
        now,
      );
      reaped += 1;
    });
  }
  return reaped;
}

/** Move retry_scheduled tasks whose backoff elapsed back to queued. */
export async function promoteRetries(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  const due = await ctx.db
    .select({ tenantId: schema.tasks.tenantId, runId: schema.tasks.runId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.state, "retry_scheduled"), lte(schema.tasks.availableAt, now)))
    .groupBy(schema.tasks.tenantId, schema.tasks.runId)
    .limit(BATCH);
  let promoted = 0;
  for (const d of due) {
    await ctx.db.transaction(async (tx) => {
      const run = await lockRun(tx, d.tenantId, d.runId);
      if (!run || run.state !== "running") return;
      const rows = await tx
        .update(schema.tasks)
        .set({ state: "queued", enqueuedAt: now, availableAt: null })
        .where(and(eq(schema.tasks.runId, d.runId), eq(schema.tasks.state, "retry_scheduled"), lte(schema.tasks.availableAt, now)))
        .returning({ id: schema.tasks.id, key: schema.tasks.key, queue: schema.tasks.queue, attempts: schema.tasks.attempts });
      promoted += rows.length;
      await recordEvents(
        tx,
        rows.map((r) => ({ tenantId: d.tenantId, runId: d.runId, taskId: r.id, type: "task.queued" as const, data: { key: r.key, queue: r.queue, retryOfAttempt: r.attempts } })),
      );
    });
  }
  return promoted;
}

/** Workers silent for longer than WORKER_OFFLINE_AFTER_MS are marked offline. Their leases expire on their own. */
export async function markOfflineWorkers(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - ctx.workerOfflineAfterMs);
  const rows = await ctx.db
    .update(schema.workers)
    .set({ state: "offline", stoppedAt: now })
    .where(and(ne(schema.workers.state, "offline"), lt(schema.workers.lastHeartbeatAt, cutoff)))
    .returning({ id: schema.workers.id, tenantId: schema.workers.tenantId });
  if (rows.length) {
    await recordEvents(ctx.db, rows.map((r) => ({ tenantId: r.tenantId, type: "worker.offline" as const, data: { workerId: r.id } })));
  }
  return rows.length;
}

/**
 * Publish outbox rows to Redis. Rows are locked with SKIP LOCKED so several relays can
 * run; a row is marked published only after a successful publish. When Redis is not
 * configured there are no subscribers, so rows are marked handled directly.
 */
export async function relayOutbox(ctx: EngineContext): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.outbox)
      .where(isNull(schema.outbox.publishedAt))
      .orderBy(asc(schema.outbox.id))
      .limit(500)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;
    if (ctx.notifier.enabled) {
      if (!ctx.notifier.healthy()) return 0; // keep rows for later; workers fall back to polling
      await ctx.notifier.publishEvents(rows.map((r) => ({ tenantId: r.tenantId, payload: r.payload as OutboxPayload })));
    }
    await tx
      .update(schema.outbox)
      .set({ publishedAt: ctx.now() })
      .where(inArray(schema.outbox.id, rows.map((r) => r.id)));
    return rows.length;
  });
}

export interface OutboxPayload {
  type: string;
  runId: string | null;
  taskId: string | null;
  data: Record<string, unknown>;
}

/** Retention: delete relayed outbox rows older than a day. */
export async function pruneOutbox(ctx: EngineContext): Promise<void> {
  await ctx.db.execute(sql`delete from outbox where published_at is not null and published_at < ${new Date(ctx.now().getTime() - 86_400_000).toISOString()}::timestamptz`);
}

/**
 * Crash recovery for runs: re-evaluate running runs that have no active work (e.g. the
 * process died between a task finishing and dependency resolution — impossible within
 * one transaction, but this keeps runs live if invariants are ever violated by manual
 * DB edits or partial restores).
 */
export async function resumeStalledRuns(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  const stalled = await ctx.db.execute<{ id: string; tenant_id: string }>(sql`
    select r.id, r.tenant_id from workflow_runs r
    where r.state = 'running'
      and not exists (select 1 from tasks t where t.run_id = r.id and t.state in ('queued','running','retry_scheduled'))
    limit ${BATCH}`);
  let advanced = 0;
  for (const r of stalled) {
    await ctx.db.transaction(async (tx) => {
      const run = await lockRun(tx, r.tenant_id, r.id);
      if (!run) return;
      await advanceRun(tx, run, now);
      advanced += 1;
    });
  }
  return advanced;
}

export async function runMaintenanceOnce(ctx: EngineContext): Promise<Record<string, number>> {
  const reaped = await reapExpiredLeases(ctx);
  const promoted = await promoteRetries(ctx);
  const offline = await markOfflineWorkers(ctx);
  const resumed = await resumeStalledRuns(ctx);
  const relayed = await relayOutbox(ctx);
  return { reaped, promoted, offline, resumed, relayed };
}
