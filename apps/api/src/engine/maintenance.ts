import { isLeaseExpired, type FailureKind } from "@flowforge/core";
import { schema } from "@flowforge/db";
import { and, eq, inArray, lt, lte, ne, sql } from "drizzle-orm";
import { ROOT_CONTEXT, type Context } from "@opentelemetry/api";
import { metrics } from "../infra/metrics.js";
import { contextFromTraceparent, withSpan } from "../infra/tracing.js";
import type { EngineContext } from "./context.js";
import { failAttempt } from "./execution.js";
import { recordEvents } from "./history.js";
import { applyRetention, type RetentionPolicy } from "./retention.js";
import { advanceRun, lockRun } from "./runs.js";

/*
 * Background maintenance. Every function is idempotent and safe to run concurrently on
 * several API instances: each state change happens under run+task row locks and
 * re-checks its precondition after locking.
 */

const BATCH = 100;

/**
 * Fair batching. Maintenance is shared by every tenant, so each round takes at most
 * `perTenant` rows per tenant (oldest first) up to `batch` rows in total. A burst from
 * one tenant — thousands of expired leases or due retries — cannot push another
 * tenant's work out of the batch. Rounds repeat while they find work (up to
 * `maxRounds` per tick), so a lone tenant's backlog still drains at
 * perTenant × maxRounds rows per tick.
 */
export interface FairBatchOptions {
  batch?: number;
  perTenant?: number;
  maxRounds?: number;
}
const FAIR_DEFAULTS = { batch: BATCH, perTenant: 20, maxRounds: 5 };

/** Maintenance on a run starts in the run's trace; a run without one gets a new root trace. */
const runTraceParent = (traceContext: string | null): Context => contextFromTraceparent(traceContext) ?? ROOT_CONTEXT;

/** Expired leases (crashed / partitioned workers) and attempts past their deadline. */
export async function reapExpiredLeases(ctx: EngineContext, opts: FairBatchOptions = {}): Promise<number> {
  const { batch, perTenant, maxRounds } = { ...FAIR_DEFAULTS, ...opts };
  let reaped = 0;
  for (let round = 0; round < maxRounds; round++) {
    const now = ctx.now();
    const expired = await ctx.db.execute<{ id: string; tenant_id: string; run_id: string; trace_context: string | null }>(sql`
      select id, tenant_id, run_id, (select trace_context from workflow_runs r where r.id = x.run_id) as trace_context from (
        select id, tenant_id, run_id, lease_expires_at,
               row_number() over (partition by tenant_id order by lease_expires_at, id) as rn
        from tasks
        where state = 'running' and lease_expires_at <= ${now.toISOString()}::timestamptz
      ) x
      where rn <= ${perTenant}
      order by lease_expires_at, id
      limit ${batch}`);
    for (const e of expired) {
      // A span in the run's own trace: the trace shows why the attempt ended (ADR-017).
      const attrs = { "flowforge.task_id": e.id, "flowforge.run_id": e.run_id };
      if (await withSpan("flowforge.reap_lease", attrs, () => reapOne(ctx, e, now), { parent: runTraceParent(e.trace_context) })) reaped += 1;
    }
    if (expired.length === 0) break;
  }
  return reaped;
}

/** Fail one expired attempt under run+task locks, re-checking expiry after locking. */
function reapOne(ctx: EngineContext, e: { id: string; tenant_id: string; run_id: string }, now: Date): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const run = await lockRun(tx, e.tenant_id, e.run_id);
    const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, e.id)).for("update");
    if (!run || !task || task.state !== "running" || !isLeaseExpired(task.leaseExpiresAt, now)) return false;
    const timedOut = task.attemptDeadline !== null && task.attemptDeadline.getTime() <= now.getTime();
    const kind: FailureKind = timedOut ? "timeout" : "lease_expired";
    const message = timedOut ? `Attempt exceeded timeout of ${task.timeoutMs}ms` : "Worker lease expired without heartbeat";
    await failAttempt(tx, run, task, kind, { message, code: kind }, now);
    return true;
  });
}

/** Move retry_scheduled tasks whose backoff elapsed back to queued (one transaction per run). */
export async function promoteRetries(ctx: EngineContext, opts: FairBatchOptions = {}): Promise<number> {
  const { batch, perTenant, maxRounds } = { ...FAIR_DEFAULTS, ...opts };
  let promoted = 0;
  for (let round = 0; round < maxRounds; round++) {
    const now = ctx.now();
    const due = await ctx.db.execute<{ tenant_id: string; run_id: string; trace_context: string | null }>(sql`
      select tenant_id, run_id, (select trace_context from workflow_runs r where r.id = x.run_id) as trace_context from (
        select tenant_id, run_id, min(available_at) as due,
               row_number() over (partition by tenant_id order by min(available_at), run_id) as rn
        from tasks
        where state = 'retry_scheduled' and available_at <= ${now.toISOString()}::timestamptz
        group by tenant_id, run_id
      ) x
      where rn <= ${perTenant}
      order by due, run_id
      limit ${batch}`);
    for (const d of due) {
      promoted += await withSpan("flowforge.promote_retries", { "flowforge.run_id": d.run_id }, () => promoteRun(ctx, d, now), {
        parent: runTraceParent(d.trace_context),
      });
    }
    if (due.length === 0) break;
  }
  return promoted;
}

/** Re-queue one run's due retries under its run lock; returns how many were promoted. */
function promoteRun(ctx: EngineContext, d: { tenant_id: string; run_id: string }, now: Date): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const run = await lockRun(tx, d.tenant_id, d.run_id);
    if (!run || run.state !== "running") return 0;
    const rows = await tx
      .update(schema.tasks)
      .set({ state: "queued", enqueuedAt: now, availableAt: null })
      .where(and(eq(schema.tasks.runId, d.run_id), eq(schema.tasks.state, "retry_scheduled"), lte(schema.tasks.availableAt, now)))
      .returning({ id: schema.tasks.id, key: schema.tasks.key, queue: schema.tasks.queue, attempts: schema.tasks.attempts });
    await recordEvents(
      tx,
      now,
      rows.map((r) => ({ tenantId: d.tenant_id, runId: d.run_id, taskId: r.id, type: "task.queued" as const, data: { key: r.key, queue: r.queue, retryOfAttempt: r.attempts } })),
    );
    return rows.length;
  });
}

/** Workers silent for longer than WORKER_OFFLINE_AFTER_MS are marked offline. Their leases expire on their own. */
export async function markOfflineWorkers(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - ctx.workerOfflineAfterMs);
  // The state change and its events commit together (or neither does).
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.workers)
      .set({ state: "offline", stoppedAt: now })
      .where(and(ne(schema.workers.state, "offline"), lt(schema.workers.lastHeartbeatAt, cutoff)))
      .returning({ id: schema.workers.id, tenantId: schema.workers.tenantId });
    await recordEvents(tx, now, rows.map((r) => ({ tenantId: r.tenantId, type: "worker.offline" as const, data: { workerId: r.id } })));
    return rows.length;
  });
}

const RELAY_BATCH = 500;
/** How long a relay's claim on outbox rows lasts if it dies before finishing. */
export const RELAY_CLAIM_MS = 30_000;

/**
 * Publish outbox rows to Redis.
 *
 * No database transaction or row lock is held while talking to Redis: rows are claimed
 * in one short statement (`relay_claimed_until`), published, then marked published. A
 * failed publish releases the claim; a relay that dies leaves the claim to lapse. So a
 * hung Redis can delay wake-ups but can never pin a database connection or block other
 * work. Delivery of wake-ups is at-least-once (a crash between publish and mark
 * re-publishes), which is harmless: consumers re-check Postgres.
 *
 * When Redis is not configured there are no subscribers, so rows are marked handled.
 */
export async function relayOutbox(ctx: EngineContext): Promise<number> {
  const now = ctx.now();
  if (!ctx.notifier.enabled) {
    const done = await ctx.db.execute<{ id: number }>(sql`
      update outbox set published_at = ${now.toISOString()}::timestamptz
      where id in (select id from outbox where published_at is null order by id limit ${RELAY_BATCH} for update skip locked)
      returning id`);
    return done.length;
  }
  // Keep rows for later while Redis is unhealthy; workers fall back to polling.
  if (!ctx.notifier.healthy()) return 0;

  const claimed = await ctx.db.execute<{ id: number; tenant_id: string; payload: OutboxPayload }>(sql`
    update outbox set relay_claimed_until = ${new Date(now.getTime() + RELAY_CLAIM_MS).toISOString()}::timestamptz
    where id in (
      select id from outbox
      where published_at is null
        and (relay_claimed_until is null or relay_claimed_until < ${now.toISOString()}::timestamptz)
      order by id limit ${RELAY_BATCH}
      for update skip locked)
    returning id, tenant_id, payload`);
  if (claimed.length === 0) return 0;
  return withSpan("flowforge.outbox_relay", { "flowforge.outbox.rows": claimed.length }, () => publishClaimed(ctx, claimed), { parent: ROOT_CONTEXT });
}

async function publishClaimed(ctx: EngineContext, claimed: Iterable<{ id: number; tenant_id: string; payload: OutboxPayload }>): Promise<number> {
  const rows = [...claimed].sort((a, b) => Number(a.id) - Number(b.id));
  const ids = rows.map((r) => Number(r.id));

  try {
    await ctx.notifier.publishEvents(rows.map((r) => ({ tenantId: r.tenant_id, payload: r.payload })));
  } catch (err) {
    // Release the claim so the next relay tick (or another instance) retries promptly.
    await ctx.db
      .update(schema.outbox)
      .set({ relayClaimedUntil: null })
      .where(inArray(schema.outbox.id, ids))
      .catch((releaseErr: unknown) => ctx.log.warn({ err: releaseErr }, "outbox claim release failed; claim will lapse"));
    throw err;
  }
  await ctx.db
    .update(schema.outbox)
    .set({ publishedAt: ctx.now(), relayClaimedUntil: null })
    .where(inArray(schema.outbox.id, ids));
  return rows.length;
}

export interface OutboxPayload {
  type: string;
  runId: string | null;
  taskId: string | null;
  data: Record<string, unknown>;
}

/**
 * Crash recovery for runs: re-evaluate running runs that have no active work (e.g. the
 * process died between a task finishing and dependency resolution — impossible within
 * one transaction, but this keeps runs live if invariants are ever violated by manual
 * DB edits or partial restores).
 */
export async function resumeStalledRuns(ctx: EngineContext, opts: FairBatchOptions = {}): Promise<number> {
  const { batch, perTenant } = { ...FAIR_DEFAULTS, ...opts };
  const now = ctx.now();
  const stalled = await ctx.db.execute<{ id: string; tenant_id: string; trace_context: string | null }>(sql`
    select id, tenant_id, trace_context from (
      select r.id, r.tenant_id, r.created_at, r.trace_context,
             row_number() over (partition by r.tenant_id order by r.created_at, r.id) as rn
      from workflow_runs r
      where r.state = 'running'
        and not exists (select 1 from tasks t where t.run_id = r.id and t.state in ('queued','running','retry_scheduled'))
    ) x
    where rn <= ${perTenant}
    order by created_at, id
    limit ${batch}`);
  let advanced = 0;
  for (const r of stalled) {
    await withSpan(
      "flowforge.resume_run",
      { "flowforge.run_id": r.id },
      () =>
        ctx.db.transaction(async (tx) => {
          const run = await lockRun(tx, r.tenant_id, r.id);
          if (!run) return;
          await advanceRun(tx, run, now);
          advanced += 1;
        }),
      { parent: runTraceParent(r.trace_context) },
    );
  }
  return advanced;
}

/**
 * One pass of correctness-critical maintenance. It touches only Postgres; the Redis
 * outbox relay runs in its own loop (see `startBackgroundLoops`) so a Redis problem can
 * never stall lease reaping, retry promotion or offline detection.
 */
export async function runMaintenanceOnce(ctx: EngineContext): Promise<Record<string, number>> {
  const reaped = await reapExpiredLeases(ctx);
  const promoted = await promoteRetries(ctx);
  const offline = await markOfflineWorkers(ctx);
  const resumed = await resumeStalledRuns(ctx);
  const rows = { reaped, promoted, offline, resumed };
  for (const [action, n] of Object.entries(rows)) if (n > 0) metrics.maintenanceRows.inc({ action }, n);
  return rows;
}

export interface BackgroundLoopOptions {
  maintenanceIntervalMs: number;
  relayIntervalMs: number;
  retentionIntervalMs: number;
  retention?: RetentionPolicy;
}

/** When a retention pass leaves aged-out rows behind, the next pass starts after this pause. */
export const RETENTION_BACKLOG_PAUSE_MS = 1_000;

/**
 * Start the background loops as independent, non-overlapping timers. Each loop logs and
 * survives its own failures; none waits on another. `stop()` resolves once every
 * in-flight tick has finished, so callers can close the pool safely afterwards.
 */
export function startBackgroundLoops(ctx: EngineContext, opts: BackgroundLoopOptions): { stop: () => Promise<void> } {
  const loops = [
    loop(ctx, "maintenance", opts.maintenanceIntervalMs, () => runMaintenanceOnce(ctx)),
    loop(ctx, "outbox-relay", opts.relayIntervalMs, async () => {
      const n = await relayOutbox(ctx);
      if (n > 0) metrics.maintenanceRows.inc({ action: "relayed" }, n);
    }),
    loop(ctx, "retention", opts.retentionIntervalMs, async () => {
      const r = await withSpan("flowforge.retention", {}, async (span) => {
        const res = await applyRetention(ctx, opts.retention);
        span.setAttributes(Object.fromEntries(Object.entries(res.deleted).map(([k, n]) => [`flowforge.retention.${k}`, n])));
        return res;
      }, { parent: ROOT_CONTEXT });
      for (const [category, n] of Object.entries(r.deleted)) if (n > 0) metrics.retentionDeleted.inc({ category }, n);
      metrics.retentionBacklog.set(r.complete ? 0 : 1);
      const total = Object.values(r.deleted).reduce((a, n) => a + n, 0);
      if (total > 0) ctx.log.info({ deleted: r.deleted, complete: r.complete }, "retention pass");
      // Drain a backlog in bounded passes instead of one long one.
      return r.complete ? undefined : RETENTION_BACKLOG_PAUSE_MS;
    }),
  ];
  return { stop: async () => void (await Promise.all(loops.map((l) => l.stop()))) };
}

/** `fn` may return a delay (ms) to use instead of `ms` before its next tick. */
function loop(ctx: EngineContext, name: string, ms: number, fn: () => Promise<unknown>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = () => {
    let next = ms;
    const end = metrics.loopDuration.startTimer({ loop: name });
    inFlight = fn()
      .then(
        (r) => {
          if (typeof r === "number") next = r;
        },
        (err: unknown) => {
          metrics.loopErrors.inc({ loop: name });
          ctx.log.error({ err, loop: name }, "background loop failed");
        },
      )
      .finally(() => {
        end();
        if (!stopped) timer = setTimeout(tick, next);
      });
  };
  timer = setTimeout(tick, ms);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
