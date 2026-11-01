import {
  assertRunTransition,
  assertTaskTransition,
  deriveRunOutcome,
  resolveDependencies,
  type RunState,
  type TaskState,
  type TriggerRule,
} from "@flowforge/core";
import { schema } from "@flowforge/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../errors.js";
import type { EngineContext, Tx } from "./context.js";
import { recordEvents, type EventInput } from "./history.js";
import { loadVersion } from "./workflows.js";

/*
 * Concurrency rule for the whole engine: any change to a task's *state* happens in a
 * transaction that first holds the owning run row lock (`lockRun`), then the task
 * row lock. This fixed order (run -> task) prevents deadlocks and makes per-run
 * decisions (dependency resolution, concurrency counts, run outcome) serialisable.
 */

export type RunRow = typeof schema.workflowRuns.$inferSelect;
export type TaskRow = typeof schema.tasks.$inferSelect;

export async function lockRun(tx: Tx, tenantId: string, runId: string): Promise<RunRow | undefined> {
  const [run] = await tx
    .select()
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.tenantId, tenantId), eq(schema.workflowRuns.id, runId)))
    .for("update");
  return run;
}

export interface SubmitRunInput {
  workflow: string;
  version?: number;
  input?: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
  triggeredBy: string;
}

export async function submitRun(
  ctx: EngineContext,
  tenantId: string,
  req: SubmitRunInput,
): Promise<{ run: RunRow; created: boolean }> {
  const v = await loadVersion(ctx, tenantId, req.workflow, req.version);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.workflowRuns)
      .values({
        tenantId,
        workflowId: v.workflowId,
        workflowVersionId: v.versionId,
        input: req.input ?? {},
        idempotencyKey: req.idempotencyKey ?? null,
        maxConcurrency: v.compiled.definition.maxConcurrency,
        priority: req.priority ?? 0,
        triggeredBy: req.triggeredBy,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [schema.workflowRuns.tenantId, schema.workflowRuns.workflowId, schema.workflowRuns.idempotencyKey],
        where: sql`${schema.workflowRuns.idempotencyKey} is not null`,
      })
      .returning();

    if (!inserted) {
      // Same idempotency key already used: return the original run.
      const [existing] = await tx
        .select()
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.tenantId, tenantId),
            eq(schema.workflowRuns.workflowId, v.workflowId),
            eq(schema.workflowRuns.idempotencyKey, req.idempotencyKey!),
          ),
        );
      return { run: existing!, created: false };
    }

    await tx.insert(schema.tasks).values(
      v.compiled.tasks.map((t) => ({
        tenantId,
        runId: inserted.id,
        key: t.key,
        type: t.type,
        queue: t.queue,
        priority: t.priority + (req.priority ?? 0),
        triggerRule: t.triggerRule,
        dependsOn: t.dependsOn,
        retryPolicy: t.retry,
        timeoutMs: t.timeoutMs,
        cpu: t.resources.cpu,
        memoryMb: t.resources.memoryMb,
        requiredCapabilities: t.requiredCapabilities,
        input: t.input,
        createdAt: now,
      })),
    );
    await recordEvents(tx, [
      {
        tenantId,
        runId: inserted.id,
        type: "run.created",
        data: { workflow: req.workflow, version: v.version, tasks: v.compiled.tasks.length, triggeredBy: req.triggeredBy },
      },
    ]);
    const run = await lockRun(tx, tenantId, inserted.id);
    await advanceRun(tx, run!, now);
    return { run: (await lockRun(tx, tenantId, inserted.id))!, created: true };
  });
}

/**
 * Apply dependency resolution to a locked run until it reaches a fixpoint, then
 * settle the run outcome. Idempotent: safe to call after any task state change,
 * including duplicated or replayed completions.
 */
export async function advanceRun(tx: Tx, run: RunRow, now: Date): Promise<void> {
  if (run.state !== "running") return;
  const tasks = await tx
    .select({
      id: schema.tasks.id,
      key: schema.tasks.key,
      state: schema.tasks.state,
      dependsOn: schema.tasks.dependsOn,
      triggerRule: schema.tasks.triggerRule,
      queue: schema.tasks.queue,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.runId, run.id));
  const byKey = new Map(tasks.map((t) => [t.key, { ...t, state: t.state as TaskState }]));
  const events: EventInput[] = [];

  for (;;) {
    const { toQueue, toSkip } = resolveDependencies(
      [...byKey.values()].map((t) => ({ key: t.key, state: t.state, dependsOn: t.dependsOn, triggerRule: t.triggerRule as TriggerRule })),
    );
    if (toQueue.length === 0 && toSkip.length === 0) break;
    for (const key of toQueue) {
      const t = byKey.get(key)!;
      assertTaskTransition(t.state, "queued");
      t.state = "queued";
      events.push({ tenantId: run.tenantId, runId: run.id, taskId: t.id, type: "task.queued", data: { key, queue: t.queue } });
    }
    for (const key of toSkip) {
      const t = byKey.get(key)!;
      assertTaskTransition(t.state, "skipped");
      t.state = "skipped";
      events.push({ tenantId: run.tenantId, runId: run.id, taskId: t.id, type: "task.skipped", data: { key } });
    }
    const queueIds = toQueue.map((k) => byKey.get(k)!.id);
    const skipIds = toSkip.map((k) => byKey.get(k)!.id);
    if (queueIds.length) {
      await tx
        .update(schema.tasks)
        .set({ state: "queued", enqueuedAt: now })
        .where(and(inArray(schema.tasks.id, queueIds), eq(schema.tasks.state, "pending")));
    }
    if (skipIds.length) {
      await tx
        .update(schema.tasks)
        .set({ state: "skipped", finishedAt: now })
        .where(and(inArray(schema.tasks.id, skipIds), eq(schema.tasks.state, "pending")));
    }
  }

  const outcome = deriveRunOutcome([...byKey.values()].map((t) => t.state));
  if (outcome) {
    assertRunTransition(run.state as RunState, outcome);
    await tx.update(schema.workflowRuns).set({ state: outcome, finishedAt: now }).where(eq(schema.workflowRuns.id, run.id));
    events.push({ tenantId: run.tenantId, runId: run.id, type: `run.${outcome}` });
  }
  await recordEvents(tx, events);
}

/**
 * Cancel a run: every non-terminal task becomes cancelled immediately. Workers holding
 * a lease learn about it from their next heartbeat; any later completion fails the
 * fence check. Side effects already performed by an in-flight handler are not undone.
 */
export async function cancelRun(ctx: EngineContext, tenantId: string, runId: string, by: string): Promise<RunRow> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const run = await lockRun(tx, tenantId, runId);
    if (!run) throw notFound("Run");
    if (run.state !== "running") throw conflict("run_not_running", `Run is already ${run.state}`);
    const active = await tx
      .select({ id: schema.tasks.id, key: schema.tasks.key, state: schema.tasks.state })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.runId, runId), inArray(schema.tasks.state, ["pending", "queued", "running", "retry_scheduled"])))
      .for("update");
    for (const t of active) assertTaskTransition(t.state as TaskState, "cancelled");
    if (active.length) {
      const ids = active.map((t) => t.id);
      await tx
        .update(schema.tasks)
        .set({ state: "cancelled", finishedAt: now, leaseExpiresAt: null })
        .where(inArray(schema.tasks.id, ids));
      await tx
        .update(schema.taskAttempts)
        .set({ outcome: "cancelled", finishedAt: now })
        .where(and(inArray(schema.taskAttempts.taskId, ids), eq(schema.taskAttempts.outcome, "running")));
    }
    assertRunTransition("running", "cancelled");
    const [updated] = await tx
      .update(schema.workflowRuns)
      .set({ state: "cancelled", cancelledAt: now, finishedAt: now })
      .where(eq(schema.workflowRuns.id, runId))
      .returning();
    await recordEvents(tx, [
      ...active.map((t) => ({ tenantId, runId, taskId: t.id, type: "task.cancelled" as const, data: { key: t.key, from: t.state } })),
      { tenantId, runId, type: "run.cancelled", data: { by } },
    ]);
    return updated!;
  });
}

/**
 * Manually retry a dead-lettered (failed) task with a fresh retry budget. Downstream
 * tasks that were skipped only because of failures are re-opened to pending, and the
 * run returns to running if it had failed.
 */
export async function retryTask(ctx: EngineContext, tenantId: string, taskId: string, by: string): Promise<TaskRow> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [ref] = await tx
      .select({ runId: schema.tasks.runId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.tenantId, tenantId), eq(schema.tasks.id, taskId)));
    if (!ref) throw notFound("Task");
    const run = await lockRun(tx, tenantId, ref.runId);
    if (!run) throw notFound("Run");
    if (run.state === "cancelled") throw conflict("run_cancelled", "Cannot retry a task in a cancelled run");
    const all = await tx.select().from(schema.tasks).where(eq(schema.tasks.runId, run.id)).for("update");
    const task = all.find((t) => t.id === taskId)!;
    if (task.state !== "failed") throw badRequest(`Only failed tasks can be retried (task is ${task.state})`);

    // Collect skipped descendants to re-open.
    const dependents = new Map<string, TaskRow[]>();
    for (const t of all) for (const d of t.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), t]);
    const reopen: TaskRow[] = [];
    const stack = [task.key];
    const seen = new Set<string>();
    while (stack.length) {
      for (const child of dependents.get(stack.pop()!) ?? []) {
        if (seen.has(child.key) || child.state !== "skipped") continue;
        seen.add(child.key);
        reopen.push(child);
        stack.push(child.key);
      }
    }

    const events: EventInput[] = [];
    if (run.state === "failed") {
      assertRunTransition("failed", "running");
      await tx.update(schema.workflowRuns).set({ state: "running", finishedAt: null }).where(eq(schema.workflowRuns.id, run.id));
      run.state = "running";
      events.push({ tenantId, runId: run.id, type: "run.reopened", data: { by, taskId } });
    }
    assertTaskTransition("failed", "queued");
    const [updated] = await tx
      .update(schema.tasks)
      .set({ state: "queued", enqueuedAt: now, retryBaseAttempts: task.attempts, error: null, finishedAt: null })
      .where(eq(schema.tasks.id, taskId))
      .returning();
    events.push({ tenantId, runId: run.id, taskId, type: "task.queued", data: { key: task.key, queue: task.queue, manualRetryBy: by } });
    for (const r of reopen) {
      assertTaskTransition("skipped", "pending");
      events.push({ tenantId, runId: run.id, taskId: r.id, type: "task.reopened", data: { key: r.key } });
    }
    if (reopen.length) {
      await tx
        .update(schema.tasks)
        .set({ state: "pending", finishedAt: null })
        .where(inArray(schema.tasks.id, reopen.map((r) => r.id)));
    }
    await tx
      .update(schema.deadLetters)
      .set({ resolvedAt: now, resolution: "retried" })
      .where(and(eq(schema.deadLetters.taskId, taskId), sql`${schema.deadLetters.resolvedAt} is null`));
    await recordEvents(tx, events);
    await advanceRun(tx, run, now);
    return updated!;
  });
}
