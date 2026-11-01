import type { TriggerRule } from "./definition.js";
import { isTerminalTaskState, type TaskState } from "./state.js";

export interface ResolvableTask {
  key: string;
  state: TaskState;
  dependsOn: readonly string[];
  triggerRule: TriggerRule;
}

export interface Resolution {
  /** pending tasks whose trigger rule is now satisfied */
  toQueue: string[];
  /** pending tasks whose trigger rule can no longer be satisfied */
  toSkip: string[];
}

/**
 * Dependency resolver. Given the current states of every task in a run, decide
 * which pending tasks become runnable and which must be skipped. Pure and
 * idempotent: calling it repeatedly on the same states yields the same answer, so
 * it is safe to re-run after crashes or duplicate completion events.
 *
 * Skips cascade: callers apply the result and call again until it is empty
 * (`resolveToFixpoint` does this for in-memory state).
 */
export function resolveDependencies(tasks: readonly ResolvableTask[]): Resolution {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const toQueue: string[] = [];
  const toSkip: string[] = [];
  for (const t of tasks) {
    if (t.state !== "pending") continue;
    const deps = t.dependsOn.map((d) => byKey.get(d));
    if (deps.some((d) => d === undefined)) {
      throw new Error(`Task ${t.key} references a dependency missing from the run`);
    }
    const states = deps.map((d) => d!.state);
    if (!states.every(isTerminalTaskState)) continue;
    // A cancelled dependency always cancels the path; it is handled by run cancellation.
    const decision = evaluateTriggerRule(t.triggerRule, states);
    if (decision === "run") toQueue.push(t.key);
    else toSkip.push(t.key);
  }
  return { toQueue: toQueue.sort(), toSkip: toSkip.sort() };
}

export function evaluateTriggerRule(rule: TriggerRule, depStates: readonly TaskState[]): "run" | "skip" {
  switch (rule) {
    case "all_succeeded":
      return depStates.every((s) => s === "succeeded") ? "run" : "skip";
    case "all_done":
      return depStates.some((s) => s === "cancelled") ? "skip" : "run";
    case "any_failed":
      return depStates.some((s) => s === "failed") ? "run" : "skip";
  }
}

/** Apply resolution repeatedly to an in-memory snapshot until nothing changes. */
export function resolveToFixpoint(tasks: readonly ResolvableTask[]): Map<string, TaskState> {
  const states = new Map(tasks.map((t) => [t.key, t.state]));
  for (;;) {
    const snapshot = tasks.map((t) => ({ ...t, state: states.get(t.key)! }));
    const { toQueue, toSkip } = resolveDependencies(snapshot);
    if (toQueue.length === 0 && toSkip.length === 0) return states;
    for (const k of toQueue) states.set(k, "queued");
    for (const k of toSkip) states.set(k, "skipped");
  }
}
