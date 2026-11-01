import {
  WorkflowDefinitionSchema,
  resolveTask,
  type ResolvedTask,
  type WorkflowDefinition,
} from "./definition.js";

export type DagIssue =
  | { code: "duplicate_key"; key: string }
  | { code: "unknown_dependency"; key: string; dependency: string }
  | { code: "self_dependency"; key: string }
  | { code: "cycle"; path: string[] }
  | { code: "schema"; path: string; message: string };

export interface CompiledWorkflow {
  definition: WorkflowDefinition;
  tasks: ResolvedTask[];
  /** Task keys in a deterministic topological order. */
  order: string[];
  /** Depth of each task (roots are 0); tasks on the same level may run in parallel. */
  levels: Record<string, number>;
  /** Reverse edges: key -> keys that depend on it. */
  dependents: Record<string, string[]>;
}

export type CompileResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; issues: DagIssue[] };

/**
 * Validate and compile an untrusted workflow definition. A workflow can only be
 * registered (and therefore executed) if this returns ok.
 */
export function compileWorkflow(input: unknown): CompileResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: "schema" as const,
        path: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const definition = parsed.data;
  const issues: DagIssue[] = [];
  const keys = new Set<string>();
  for (const t of definition.tasks) {
    if (keys.has(t.key)) issues.push({ code: "duplicate_key", key: t.key });
    keys.add(t.key);
  }
  for (const t of definition.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.key) issues.push({ code: "self_dependency", key: t.key });
      else if (!keys.has(d)) issues.push({ code: "unknown_dependency", key: t.key, dependency: d });
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const tasks = definition.tasks.map((t) => resolveTask(definition, t));
  const cycle = findCycle(tasks);
  if (cycle) return { ok: false, issues: [{ code: "cycle", path: cycle }] };

  const order = topologicalOrder(tasks);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const levels: Record<string, number> = {};
  for (const key of order) {
    const deps = byKey.get(key)!.dependsOn;
    levels[key] = deps.length === 0 ? 0 : Math.max(...deps.map((d) => levels[d]!)) + 1;
  }
  const dependents: Record<string, string[]> = Object.fromEntries(tasks.map((t) => [t.key, []]));
  for (const t of tasks) for (const d of t.dependsOn) dependents[d]!.push(t.key);
  for (const k of Object.keys(dependents)) dependents[k]!.sort();

  return { ok: true, workflow: { definition, tasks, order, levels, dependents } };
}

/** Returns one cycle as a closed path (first === last), or null. Iterative DFS. */
export function findCycle(tasks: Pick<ResolvedTask, "key" | "dependsOn">[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(tasks.map((t) => [t.key, WHITE]));
  const parent = new Map<string, string>();

  for (const start of [...deps.keys()].sort()) {
    if (color.get(start) !== WHITE) continue;
    const stack: { key: string; next: number }[] = [{ key: start, next: 0 }];
    color.set(start, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = deps.get(frame.key) ?? [];
      if (frame.next >= edges.length) {
        color.set(frame.key, BLACK);
        stack.pop();
        continue;
      }
      const dep = edges[frame.next++]!;
      const c = color.get(dep);
      if (c === GREY) {
        // Walk parents from frame.key back to dep to reconstruct the cycle.
        const path = [dep];
        let cur: string | undefined = frame.key;
        while (cur !== undefined && cur !== dep) {
          path.push(cur);
          cur = parent.get(cur);
        }
        path.push(dep);
        return path.reverse();
      }
      if (c === WHITE) {
        parent.set(dep, frame.key);
        color.set(dep, GREY);
        stack.push({ key: dep, next: 0 });
      }
    }
  }
  return null;
}

/** Kahn's algorithm with lexical tie-breaking so the order is deterministic. Assumes acyclic. */
export function topologicalOrder(tasks: Pick<ResolvedTask, "key" | "dependsOn">[]): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.key, t.dependsOn.length);
    for (const d of t.dependsOn) {
      const list = dependents.get(d) ?? [];
      list.push(t.key);
      dependents.set(d, list);
    }
  }
  const ready = [...indegree].filter(([, n]) => n === 0).map(([k]) => k).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    order.push(key);
    for (const next of dependents.get(key) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) {
        // insert keeping `ready` sorted
        const idx = ready.findIndex((r) => r > next);
        if (idx === -1) ready.push(next);
        else ready.splice(idx, 0, next);
      }
    }
  }
  if (order.length !== tasks.length) throw new Error("topologicalOrder called on a cyclic graph");
  return order;
}

export function formatDagIssue(issue: DagIssue): string {
  switch (issue.code) {
    case "duplicate_key":
      return `Task key "${issue.key}" is defined more than once`;
    case "unknown_dependency":
      return `Task "${issue.key}" depends on unknown task "${issue.dependency}"`;
    case "self_dependency":
      return `Task "${issue.key}" depends on itself`;
    case "cycle":
      return `Dependency cycle: ${issue.path.join(" -> ")}`;
    case "schema":
      return `${issue.path || "(root)"}: ${issue.message}`;
  }
}
