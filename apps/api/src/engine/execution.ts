import {
  DEFAULT_SCHEDULING,
  assertTaskTransition,
  checkFence,
  decideRetry,
  selectTasks,
  type CandidateTask,
  type FailureKind,
  type RetryPolicy,
  type TaskState,
} from "@flowforge/core";
import { schema } from "@flowforge/db";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { AppError, conflict, notFound } from "../errors.js";
import type { Advice, EngineContext, Tx } from "./context.js";
import { recordEvents } from "./history.js";
import { advanceRun, lockRun, type RunRow, type TaskRow } from "./runs.js";

const CANDIDATE_WINDOW = 200;

export interface WorkerRow {
  id: string;
  tenantId: string;
  state: string;
  queues: string[];
  capabilities: string[];
  taskTypes: string[];
}

export interface ClaimCapacity {
  freeSlots: number;
  freeCpu: number;
  freeMemoryMb: number;
}

export interface LeasedTask {
  taskId: string;
  runId: string;
  key: string;
  type: string;
  attempt: number;
  fence: number;
  input: Record<string, unknown>;
  runInput: Record<string, unknown>;
  checkpoint: unknown;
  timeoutMs: number;
  resources: { cpu: number; memoryMb: number };
  leaseExpiresAt: string;
  attemptDeadline: string;
  /** Stable across attempts; handlers use it to make external side effects idempotent. */
  idempotencyKey: string;
}

/**
 * Lease runnable tasks to a worker. Candidates are read without locks, ranked by the
 * deterministic policy (optionally nudged by the advisor), then each chosen task is
 * claimed under its run lock with `state = 'queued'` as the guard, so concurrent
 * claimers can never lease the same task twice.
 */
export async function claimTasks(ctx: EngineContext, worker: WorkerRow, capacity: ClaimCapacity): Promise<LeasedTask[]> {
  if (worker.state !== "active" || capacity.freeSlots <= 0) return [];
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const candidates = await tx
      .select({
        id: schema.tasks.id,
        runId: schema.tasks.runId,
        type: schema.tasks.type,
        queue: schema.tasks.queue,
        priority: schema.tasks.priority,
        enqueuedAt: schema.tasks.enqueuedAt,
        requiredCapabilities: schema.tasks.requiredCapabilities,
        cpu: schema.tasks.cpu,
        memoryMb: schema.tasks.memoryMb,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.tenantId, worker.tenantId),
          eq(schema.tasks.state, "queued"),
          inArray(schema.tasks.queue, worker.queues),
          inArray(schema.tasks.type, worker.taskTypes),
        ),
      )
      .orderBy(desc(schema.tasks.priority), asc(schema.tasks.enqueuedAt))
      .limit(CANDIDATE_WINDOW);
    if (candidates.length === 0) return [];

    const runIds = [...new Set(candidates.map((c) => c.runId))];
    const runs = await tx
      .select({ id: schema.workflowRuns.id, maxConcurrency: schema.workflowRuns.maxConcurrency })
      .from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.id, runIds));
    const running = await tx
      .select({ runId: schema.tasks.runId, n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(and(inArray(schema.tasks.runId, runIds), eq(schema.tasks.state, "running")))
      .groupBy(schema.tasks.runId);
    const [tenant] = await tx
      .select({ max: schema.tenants.maxConcurrency, running: sql<number>`(select count(*)::int from tasks where tenant_id = ${worker.tenantId} and state = 'running')` })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, worker.tenantId));

    const pool: CandidateTask[] = candidates.map((c) => ({
      id: c.id,
      runId: c.runId,
      tenantId: worker.tenantId,
      taskType: c.type,
      queue: c.queue,
      priority: c.priority,
      enqueuedAt: c.enqueuedAt ?? now,
      requiredCapabilities: c.requiredCapabilities,
      resources: { cpu: c.cpu, memoryMb: c.memoryMb },
    }));

    let advice = new Map<string, Advice>();
    if (ctx.advisor) {
      try {
        advice = await ctx.advisor.advise(tx, worker.tenantId, [...new Set(pool.map((p) => p.taskType))]);
      } catch (err) {
        // Advisory only: any failure falls back to the deterministic policy.
        ctx.log.warn({ err }, "scheduling advisor failed; using deterministic policy");
        advice = new Map();
      }
    }

    const result = selectTasks(
      pool,
      { queues: worker.queues, taskTypes: worker.taskTypes, capabilities: worker.capabilities, ...capacity },
      {
        now,
        agingIntervalMs: DEFAULT_SCHEDULING.agingIntervalMs,
        maxAgingBoost: DEFAULT_SCHEDULING.maxAgingBoost,
        runRunning: new Map(running.map((r) => [r.runId, r.n])),
        runMaxConcurrency: new Map(runs.map((r) => [r.id, r.maxConcurrency])),
        tenantRunning: new Map([[worker.tenantId, tenant?.running ?? 0]]),
        tenantMaxConcurrency: tenant?.max ?? DEFAULT_SCHEDULING.tenantMaxConcurrency,
        ...(advice.size > 0 ? { advisor: (t: CandidateTask) => advice.get(t.taskType)?.adjustment ?? 0 } : {}),
      },
    );

    // Claim in run-id order (lock ordering), re-checking concurrency under the run lock.
    const byRun = new Map<string, CandidateTask[]>();
    for (const t of result.selected) byRun.set(t.runId, [...(byRun.get(t.runId) ?? []), t]);
    const leased: LeasedTask[] = [];
    for (const runId of [...byRun.keys()].sort()) {
      const [run] = await tx
        .select()
        .from(schema.workflowRuns)
        .where(and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.state, "running")))
        .for("update", { skipLocked: true });
      if (!run) continue; // busy (another transaction is advancing it) or no longer running
      const [{ n: runningNow } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.runId, runId), eq(schema.tasks.state, "running")));
      let slots = run.maxConcurrency - runningNow;
      for (const cand of byRun.get(runId)!) {
        if (slots <= 0) break;
        const claimed = await leaseOne(ctx, tx, run, cand.id, worker.id, now);
        if (!claimed) continue;
        slots -= 1;
        leased.push(claimed);
        const a = advice.get(cand.taskType);
        await tx.insert(schema.schedulingDecisions).values({
          tenantId: worker.tenantId,
          taskId: cand.id,
          workerId: worker.id,
          strategy: a ? "predictive" : "deterministic",
          score: result.scores.get(cand.id) ?? cand.priority,
          advisorUsed: Boolean(a),
          predictedDurationMs: a?.predictedDurationMs ?? null,
          confidence: a?.confidence ?? null,
          modelVersion: a ? (ctx.advisor?.modelVersion ?? null) : null,
          createdAt: now,
        });
      }
    }
    return leased;
  });
}

async function leaseOne(ctx: EngineContext, tx: Tx, run: RunRow, taskId: string, workerId: string, now: Date): Promise<LeasedTask | null> {
  assertTaskTransition("queued", "running");
  const [t] = await tx
    .update(schema.tasks)
    .set({
      state: "running",
      fence: sql`${schema.tasks.fence} + 1`,
      attempts: sql`${schema.tasks.attempts} + 1`,
      workerId,
      attemptDeadline: sql`${now.toISOString()}::timestamptz + (${schema.tasks.timeoutMs} || ' milliseconds')::interval`,
      leaseExpiresAt: sql`least(${new Date(now.getTime() + ctx.leaseDurationMs).toISOString()}::timestamptz, ${now.toISOString()}::timestamptz + (${schema.tasks.timeoutMs} || ' milliseconds')::interval)`,
      startedAt: sql`coalesce(${schema.tasks.startedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.state, "queued")))
    .returning();
  if (!t) return null;
  await tx.insert(schema.taskAttempts).values({
    tenantId: t.tenantId,
    taskId: t.id,
    runId: t.runId,
    attempt: t.attempts,
    fence: t.fence,
    workerId,
    startedAt: now,
  });
  await recordEvents(tx, [
    { tenantId: t.tenantId, runId: t.runId, taskId: t.id, type: "task.started", data: { key: t.key, attempt: t.attempts, workerId } },
  ]);
  return {
    taskId: t.id,
    runId: t.runId,
    key: t.key,
    type: t.type,
    attempt: t.attempts,
    fence: t.fence,
    input: t.input as Record<string, unknown>,
    runInput: run.input as Record<string, unknown>,
    checkpoint: t.checkpoint,
    timeoutMs: t.timeoutMs,
    resources: { cpu: t.cpu, memoryMb: t.memoryMb },
    leaseExpiresAt: t.leaseExpiresAt!.toISOString(),
    attemptDeadline: t.attemptDeadline!.toISOString(),
    idempotencyKey: `${t.runId}:${t.key}`,
  };
}

export interface FencedRequest {
  tenantId: string;
  taskId: string;
  workerId: string;
  fence: number;
}

/** Lock run then task for a fenced state change; throws 409 if the lease is not current. */
async function lockForFencedChange(tx: Tx, req: FencedRequest, now: Date): Promise<{ run: RunRow; task: TaskRow } | { duplicate: TaskRow }> {
  const [ref] = await tx
    .select({ runId: schema.tasks.runId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.tenantId, req.tenantId), eq(schema.tasks.id, req.taskId)));
  if (!ref) throw notFound("Task");
  const run = (await lockRun(tx, req.tenantId, ref.runId))!;
  const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, req.taskId)).for("update");
  const check = checkFence(
    { running: task!.state === "running", fence: task!.fence, workerId: task!.workerId, leaseExpiresAt: task!.leaseExpiresAt },
    { fence: req.fence, workerId: req.workerId },
    now,
  );
  if (!check.ok) {
    // A retransmitted acknowledgement for an attempt we already recorded is not an error.
    if (check.reason === "not_running" && task!.fence === req.fence && task!.workerId === req.workerId && task!.state !== "cancelled") {
      return { duplicate: task! };
    }
    throw conflict("lease_lost", `Lease is no longer held (${check.reason})`, { reason: check.reason, state: task!.state });
  }
  return { run, task: task! };
}

export async function completeTask(ctx: EngineContext, req: FencedRequest & { output: unknown }): Promise<{ duplicate: boolean }> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const locked = await lockForFencedChange(tx, req, now);
    if ("duplicate" in locked) {
      if (locked.duplicate.state !== "succeeded") throw conflict("lease_lost", "Attempt already resolved as " + locked.duplicate.state);
      return { duplicate: true };
    }
    const { run, task } = locked;
    assertTaskTransition("running", "succeeded");
    await tx
      .update(schema.tasks)
      .set({ state: "succeeded", output: req.output ?? null, error: null, finishedAt: now, leaseExpiresAt: null })
      .where(eq(schema.tasks.id, task.id));
    const durationMs = await finishAttempt(tx, task, "succeeded", null, now);
    await recordTaskStats(tx, task.tenantId, task.type, durationMs, true);
    await recordEvents(tx, [{ tenantId: task.tenantId, runId: run.id, taskId: task.id, type: "task.succeeded", data: { key: task.key, attempt: task.attempts, durationMs } }]);
    await advanceRun(tx, run, now);
    return { duplicate: false };
  });
}

export interface TaskErrorInput {
  message: string;
  code?: string;
  retryable?: boolean;
}

export async function failTask(ctx: EngineContext, req: FencedRequest & { error: TaskErrorInput }): Promise<{ willRetry: boolean; duplicate: boolean }> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const locked = await lockForFencedChange(tx, req, now);
    if ("duplicate" in locked) {
      const s = locked.duplicate.state;
      if (s !== "failed" && s !== "retry_scheduled" && s !== "queued") throw conflict("lease_lost", "Attempt already resolved as " + s);
      return { willRetry: s !== "failed", duplicate: true };
    }
    const kind: FailureKind = req.error.retryable === false ? "non_retryable" : "error";
    const willRetry = await failAttempt(tx, locked.run, locked.task, kind, req.error, now);
    return { willRetry, duplicate: false };
  });
}

/**
 * Record a failed attempt and decide between retry and dead-letter. Shared by worker
 * failure reports, the lease reaper (lease_expired / timeout) and worker deregistration.
 * Caller holds run + task locks and has verified the task is running.
 */
export async function failAttempt(tx: Tx, run: RunRow, task: TaskRow, kind: FailureKind, error: TaskErrorInput, now: Date): Promise<boolean> {
  const policy = task.retryPolicy as RetryPolicy;
  const decision = decideRetry(policy, task.attempts - task.retryBaseAttempts, kind);
  const errorJson = { message: error.message.slice(0, 4_000), code: error.code ?? kind, kind, attempt: task.attempts };
  const outcome = kind === "timeout" ? "timed_out" : kind === "lease_expired" ? "lease_expired" : "failed";
  const durationMs = await finishAttempt(tx, task, outcome, errorJson, now);
  await recordTaskStats(tx, task.tenantId, task.type, durationMs, false);

  if (decision.retry) {
    assertTaskTransition("running", "retry_scheduled");
    const availableAt = new Date(now.getTime() + decision.delayMs);
    await tx
      .update(schema.tasks)
      .set({ state: "retry_scheduled", error: errorJson, availableAt, leaseExpiresAt: null })
      .where(eq(schema.tasks.id, task.id));
    await recordEvents(tx, [
      { tenantId: task.tenantId, runId: run.id, taskId: task.id, type: "task.retry_scheduled", data: { key: task.key, attempt: task.attempts, delayMs: decision.delayMs, kind } },
    ]);
    return true;
  }
  assertTaskTransition("running", "failed");
  await tx
    .update(schema.tasks)
    .set({ state: "failed", error: errorJson, finishedAt: now, leaseExpiresAt: null })
    .where(eq(schema.tasks.id, task.id));
  await tx.insert(schema.deadLetters).values({
    tenantId: task.tenantId,
    taskId: task.id,
    runId: run.id,
    reason: kind === "non_retryable" ? "non_retryable_error" : "retries_exhausted",
    attempts: task.attempts,
    lastError: errorJson,
    createdAt: now,
  });
  await recordEvents(tx, [{ tenantId: task.tenantId, runId: run.id, taskId: task.id, type: "task.failed", data: { key: task.key, attempt: task.attempts, kind } }]);
  await advanceRun(tx, run, now);
  return false;
}

async function finishAttempt(tx: Tx, task: TaskRow, outcome: "succeeded" | "failed" | "timed_out" | "lease_expired", error: unknown, now: Date): Promise<number> {
  const [a] = await tx
    .update(schema.taskAttempts)
    .set({
      outcome,
      finishedAt: now,
      error,
      durationMs: sql`greatest(0, (extract(epoch from (${now.toISOString()}::timestamptz - ${schema.taskAttempts.startedAt})) * 1000)::int)`,
    })
    .where(and(eq(schema.taskAttempts.taskId, task.id), eq(schema.taskAttempts.attempt, task.attempts)))
    .returning({ durationMs: schema.taskAttempts.durationMs });
  return a?.durationMs ?? 0;
}

/** Welford running mean/variance plus an EWMA of successful durations, per task type. */
async function recordTaskStats(tx: Tx, tenantId: string, taskType: string, durationMs: number, success: boolean): Promise<void> {
  const t = schema.taskTypeStats;
  if (!success) {
    await tx
      .insert(t)
      .values({ tenantId, taskType, failures: 1 })
      .onConflictDoUpdate({ target: [t.tenantId, t.taskType], set: { failures: sql`${t.failures} + 1`, updatedAt: sql`now()` } });
    return;
  }
  const d = durationMs;
  await tx
    .insert(t)
    .values({ tenantId, taskType, samples: 1, meanDurationMs: d, m2DurationMs: 0, ewmaDurationMs: d })
    .onConflictDoUpdate({
      target: [t.tenantId, t.taskType],
      set: {
        samples: sql`${t.samples} + 1`,
        meanDurationMs: sql`${t.meanDurationMs} + (${d} - ${t.meanDurationMs}) / (${t.samples} + 1)`,
        m2DurationMs: sql`${t.m2DurationMs} + (${d} - ${t.meanDurationMs}) * (${d} - (${t.meanDurationMs} + (${d} - ${t.meanDurationMs}) / (${t.samples} + 1)))`,
        ewmaDurationMs: sql`case when ${t.samples} = 0 then ${d}::float8 else 0.2 * ${d} + 0.8 * ${t.ewmaDurationMs} end`,
        updatedAt: sql`now()`,
      },
    });
}

export interface HeartbeatResult {
  /** Leases renewed. */
  renewed: { taskId: string; leaseExpiresAt: string }[];
  /** Tasks the worker must stop: cancelled, re-leased elsewhere, or expired. */
  revoked: { taskId: string; reason: string }[];
}

/**
 * Renew leases for tasks the worker is still executing. Only the lease column changes
 * (no state transition), guarded by fence, owner and unexpired lease, so it cannot race
 * the reaper into an inconsistent state.
 */
export async function renewLeases(ctx: EngineContext, tenantId: string, workerId: string, active: { taskId: string; fence: number }[]): Promise<HeartbeatResult> {
  const now = ctx.now();
  const renewed: HeartbeatResult["renewed"] = [];
  const revoked: HeartbeatResult["revoked"] = [];
  for (const a of active) {
    const [r] = await ctx.db
      .update(schema.tasks)
      .set({
        leaseExpiresAt: sql`least(${new Date(now.getTime() + ctx.leaseDurationMs).toISOString()}::timestamptz, ${schema.tasks.attemptDeadline})`,
      })
      .where(
        and(
          eq(schema.tasks.tenantId, tenantId),
          eq(schema.tasks.id, a.taskId),
          eq(schema.tasks.state, "running"),
          eq(schema.tasks.workerId, workerId),
          eq(schema.tasks.fence, a.fence),
          gt(schema.tasks.leaseExpiresAt, now),
        ),
      )
      .returning({ leaseExpiresAt: schema.tasks.leaseExpiresAt });
    if (r) renewed.push({ taskId: a.taskId, leaseExpiresAt: r.leaseExpiresAt!.toISOString() });
    else {
      const [cur] = await ctx.db
        .select({ state: schema.tasks.state, fence: schema.tasks.fence })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.tenantId, tenantId), eq(schema.tasks.id, a.taskId)));
      revoked.push({
        taskId: a.taskId,
        reason: !cur ? "not_found" : cur.state === "cancelled" ? "cancelled" : cur.fence !== a.fence ? "stale_fence" : (cur.state as TaskState) === "running" ? "lease_expired" : cur.state,
      });
    }
  }
  return { renewed, revoked };
}

const MAX_CHECKPOINT_BYTES = 256 * 1024;

export async function saveCheckpoint(ctx: EngineContext, req: FencedRequest & { checkpoint: unknown }): Promise<void> {
  if (JSON.stringify(req.checkpoint ?? null).length > MAX_CHECKPOINT_BYTES) {
    throw new AppError(413, "checkpoint_too_large", `Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
  }
  const now = ctx.now();
  const [r] = await ctx.db
    .update(schema.tasks)
    .set({ checkpoint: req.checkpoint ?? null, checkpointAt: now })
    .where(
      and(
        eq(schema.tasks.tenantId, req.tenantId),
        eq(schema.tasks.id, req.taskId),
        eq(schema.tasks.state, "running"),
        eq(schema.tasks.workerId, req.workerId),
        eq(schema.tasks.fence, req.fence),
        gt(schema.tasks.leaseExpiresAt, now),
      ),
    )
    .returning({ runId: schema.tasks.runId, key: schema.tasks.key });
  if (!r) throw conflict("lease_lost", "Lease is no longer held");
  await recordEvents(ctx.db, [{ tenantId: req.tenantId, runId: r.runId, taskId: req.taskId, type: "task.checkpointed", data: { key: r.key } }]);
}
