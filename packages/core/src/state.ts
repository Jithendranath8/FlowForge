/**
 * Task and run state machines. Every persisted state change goes through
 * `assertTaskTransition` / `assertRunTransition` so illegal transitions fail loudly.
 */

export const TASK_STATES = [
  "pending", // waiting on dependencies
  "queued", // runnable, waiting for a worker
  "running", // leased to a worker
  "retry_scheduled", // failed attempt, waiting for backoff to elapse
  "succeeded",
  "failed", // retries exhausted or non-retryable error; dead-lettered
  "skipped", // trigger rule not satisfied
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  pending: ["queued", "skipped", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["succeeded", "retry_scheduled", "failed", "cancelled"],
  retry_scheduled: ["queued", "cancelled"],
  succeeded: [],
  failed: ["queued"], // manual retry of a dead-lettered task
  skipped: ["pending"], // re-opened when the upstream failure that skipped it is manually retried
  cancelled: [],
};

export function isTerminalTaskState(s: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(s);
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "task" | "run",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError("task", from, to);
}

export const RUN_STATES = ["running", "succeeded", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: ["running"], // manual retry of failed tasks re-opens the run
  cancelled: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to);
}

export function isTerminalRunState(s: RunState): boolean {
  return s === "succeeded" || s === "failed" || s === "cancelled";
}

/**
 * Derive the outcome of a run from its task states. Returns null while work remains.
 * A run succeeds when every task is succeeded or skipped; it fails if any task failed
 * (tasks downstream of a failure are skipped or ran via `all_done`/`any_failed`).
 */
export function deriveRunOutcome(states: readonly TaskState[]): "succeeded" | "failed" | "cancelled" | null {
  if (states.some((s) => !isTerminalTaskState(s))) return null;
  if (states.some((s) => s === "cancelled")) return "cancelled";
  if (states.some((s) => s === "failed")) return "failed";
  return "succeeded";
}
