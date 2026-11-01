/**
 * Deterministic scheduling policy.
 *
 * Given a window of runnable candidates and the capacity a polling worker reports,
 * choose which tasks to lease to it. Hard constraints (queue membership,
 * task types, capabilities, resources, per-run concurrency, per-tenant limits, slot
 * count) are never violated. Ordering is priority with aging, fair-shared across runs
 * so one large run cannot starve the others.
 *
 * An optional advisor (e.g. the predictive scheduler) may nudge ordering through a
 * bounded score adjustment; it cannot make an ineligible task eligible.
 */

export interface CandidateTask {
  id: string;
  runId: string;
  tenantId: string;
  taskType: string;
  queue: string;
  priority: number;
  enqueuedAt: Date;
  requiredCapabilities: readonly string[];
  resources: { cpu: number; memoryMb: number };
}

export interface WorkerCapacity {
  queues: readonly string[];
  /** Task types the worker has handlers for. */
  taskTypes: readonly string[];
  capabilities: readonly string[];
  freeSlots: number;
  freeCpu: number;
  freeMemoryMb: number;
}

export interface SchedulingContext {
  now: Date;
  /** Every `agingIntervalMs` waited adds +1 effective priority, up to `maxAgingBoost`. */
  agingIntervalMs: number;
  maxAgingBoost: number;
  /** Tasks currently running per run, and each run's concurrency cap. */
  runRunning: ReadonlyMap<string, number>;
  runMaxConcurrency: ReadonlyMap<string, number>;
  /** Tasks currently running per tenant and the tenant-wide cap. */
  tenantRunning: ReadonlyMap<string, number>;
  tenantMaxConcurrency: number;
  /** Optional advisory adjustment, clamped to ±maxAdvisorAdjustment. */
  advisor?: (task: CandidateTask) => number;
  maxAdvisorAdjustment?: number;
}

export type RejectionReason =
  | "queue_not_served"
  | "task_type_not_supported"
  | "missing_capability"
  | "insufficient_cpu"
  | "insufficient_memory"
  | "run_concurrency_limit"
  | "tenant_concurrency_limit"
  | "no_free_slots";

export interface SchedulingResult {
  selected: CandidateTask[];
  scores: Map<string, number>;
  rejected: Map<string, RejectionReason>;
}

export const DEFAULT_SCHEDULING = {
  agingIntervalMs: 30_000,
  maxAgingBoost: 50,
  tenantMaxConcurrency: 256,
  maxAdvisorAdjustment: 10,
} as const;

export function effectiveScore(task: CandidateTask, ctx: SchedulingContext): number {
  const waited = Math.max(0, ctx.now.getTime() - task.enqueuedAt.getTime());
  const aging = Math.min(ctx.maxAgingBoost, Math.floor(waited / ctx.agingIntervalMs));
  let advice = 0;
  if (ctx.advisor) {
    const bound = ctx.maxAdvisorAdjustment ?? DEFAULT_SCHEDULING.maxAdvisorAdjustment;
    const raw = ctx.advisor(task);
    advice = Number.isFinite(raw) ? Math.max(-bound, Math.min(bound, raw)) : 0;
  }
  return task.priority + aging + advice;
}

export function selectTasks(
  candidates: readonly CandidateTask[],
  worker: WorkerCapacity,
  ctx: SchedulingContext,
): SchedulingResult {
  const rejected = new Map<string, RejectionReason>();
  const scores = new Map<string, number>();
  const queues = new Set(worker.queues);
  const caps = new Set(worker.capabilities);
  const types = new Set(worker.taskTypes);

  const eligible: CandidateTask[] = [];
  for (const c of candidates) {
    if (!queues.has(c.queue)) rejected.set(c.id, "queue_not_served");
    else if (!types.has(c.taskType)) rejected.set(c.id, "task_type_not_supported");
    else if (!c.requiredCapabilities.every((r) => caps.has(r))) rejected.set(c.id, "missing_capability");
    else {
      eligible.push(c);
      scores.set(c.id, effectiveScore(c, ctx));
    }
  }

  // Per-run lists ordered by score desc, then FIFO, then id for determinism.
  const byRun = new Map<string, CandidateTask[]>();
  for (const c of eligible) {
    const list = byRun.get(c.runId) ?? [];
    list.push(c);
    byRun.set(c.runId, list);
  }
  for (const list of byRun.values()) {
    list.sort(
      (a, b) =>
        scores.get(b.id)! - scores.get(a.id)! ||
        a.enqueuedAt.getTime() - b.enqueuedAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  const runCount = new Map(ctx.runRunning);
  const tenantCount = new Map(ctx.tenantRunning);
  let slots = worker.freeSlots;
  let cpu = worker.freeCpu;
  let mem = worker.freeMemoryMb;
  const selected: CandidateTask[] = [];

  // Each round serves the run whose best remaining task scores highest; ties go to
  // the run with fewer running+selected tasks (fair share), then to the lower run id.
  while (byRun.size > 0) {
    let pick: string | null = null;
    for (const [run, list] of byRun) {
      if (pick === null) {
        pick = run;
        continue;
      }
      const sa = scores.get(list[0]!.id)!;
      const sb = scores.get(byRun.get(pick)![0]!.id)!;
      const a = runCount.get(run) ?? 0;
      const b = runCount.get(pick) ?? 0;
      if (sa > sb || (sa === sb && (a < b || (a === b && run < pick)))) pick = run;
    }
    const list = byRun.get(pick!)!;
    const task = list.shift()!;
    if (list.length === 0) byRun.delete(pick!);

    const reason = checkFit(task);
    if (reason) {
      rejected.set(task.id, reason);
      continue;
    }
    selected.push(task);
    slots -= 1;
    cpu -= task.resources.cpu;
    mem -= task.resources.memoryMb;
    runCount.set(task.runId, (runCount.get(task.runId) ?? 0) + 1);
    tenantCount.set(task.tenantId, (tenantCount.get(task.tenantId) ?? 0) + 1);
  }

  return { selected, scores, rejected };

  function checkFit(task: CandidateTask): RejectionReason | null {
    if (slots <= 0) return "no_free_slots";
    if (task.resources.cpu > cpu) return "insufficient_cpu";
    if (task.resources.memoryMb > mem) return "insufficient_memory";
    const runMax = ctx.runMaxConcurrency.get(task.runId) ?? Number.POSITIVE_INFINITY;
    if ((runCount.get(task.runId) ?? 0) >= runMax) return "run_concurrency_limit";
    if ((tenantCount.get(task.tenantId) ?? 0) >= ctx.tenantMaxConcurrency) return "tenant_concurrency_limit";
    return null;
  }
}
