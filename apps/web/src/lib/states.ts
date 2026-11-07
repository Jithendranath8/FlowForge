/** Task and run states as the API reports them, with how the UI presents each one. */
export type TaskState = "pending" | "queued" | "running" | "retry_scheduled" | "succeeded" | "failed" | "skipped" | "cancelled";
export type RunState = "running" | "succeeded" | "failed" | "cancelled";

export interface StateStyle {
  label: string;
  /** CSS colour variable for the state (status colours are reserved for state). */
  color: string;
  /** Shape cue so state never depends on colour alone. */
  icon: "dot" | "pulse" | "check" | "cross" | "retry" | "dash" | "ring";
}

export const STATE_STYLE: Record<TaskState, StateStyle> = {
  pending: { label: "Waiting", color: "var(--st-queued)", icon: "ring" },
  queued: { label: "Queued", color: "var(--st-queued)", icon: "dot" },
  running: { label: "Running", color: "var(--st-running)", icon: "pulse" },
  retry_scheduled: { label: "Retrying", color: "var(--st-retrying)", icon: "retry" },
  succeeded: { label: "Succeeded", color: "var(--st-succeeded)", icon: "check" },
  failed: { label: "Failed", color: "var(--st-failed)", icon: "cross" },
  skipped: { label: "Skipped", color: "var(--st-cancelled)", icon: "dash" },
  cancelled: { label: "Cancelled", color: "var(--st-cancelled)", icon: "dash" },
};

export const isTerminal = (s: TaskState) => s === "succeeded" || s === "failed" || s === "skipped" || s === "cancelled";

/** How a task attempt ended (or "running"), as the API reports it. */
export type AttemptOutcome = "running" | "succeeded" | "failed" | "timed_out" | "lease_expired" | "cancelled";

/**
 * Attempts get their own labels: an attempt whose lease expired did not "retry"; the
 * task may be retried, and the task's badge says so. Colours match the monitoring charts.
 */
export const ATTEMPT_STYLE: Record<AttemptOutcome, StateStyle> = {
  running: { label: "Running", color: "var(--st-running)", icon: "pulse" },
  succeeded: { label: "Succeeded", color: "var(--st-succeeded)", icon: "check" },
  failed: { label: "Failed", color: "var(--st-failed)", icon: "cross" },
  timed_out: { label: "Timed out", color: "var(--st-serious)", icon: "cross" },
  lease_expired: { label: "Lease expired", color: "var(--st-retrying)", icon: "cross" },
  cancelled: { label: "Cancelled", color: "var(--st-cancelled)", icon: "dash" },
};

export const ATTEMPT_OUTCOMES = Object.keys(ATTEMPT_STYLE) as AttemptOutcome[];
