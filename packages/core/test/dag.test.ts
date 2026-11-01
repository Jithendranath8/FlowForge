import { describe, expect, it } from "vitest";
import { compileWorkflow, findCycle, formatDagIssue, topologicalOrder } from "../src/index.js";

const wf = (tasks: unknown[]) => ({ name: "etl", tasks });

describe("compileWorkflow", () => {
  it("compiles a diamond DAG with deterministic order and levels", () => {
    const r = compileWorkflow(
      wf([
        { key: "extract", type: "etl.extract" },
        { key: "clean", type: "etl.clean", dependsOn: ["extract"] },
        { key: "enrich", type: "etl.enrich", dependsOn: ["extract"] },
        { key: "load", type: "etl.load", dependsOn: ["enrich", "clean"] },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workflow.order).toEqual(["extract", "clean", "enrich", "load"]);
    expect(r.workflow.levels).toEqual({ extract: 0, clean: 1, enrich: 1, load: 2 });
    expect(r.workflow.dependents.extract).toEqual(["clean", "enrich"]);
  });

  it("resolves defaults into every task", () => {
    const r = compileWorkflow({
      name: "x",
      defaults: { timeoutMs: 10_000, queue: "gpu" },
      tasks: [{ key: "a", type: "t" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a] = r.workflow.tasks;
    expect(a).toMatchObject({ queue: "gpu", timeoutMs: 10_000, priority: 0, triggerRule: "all_succeeded" });
    expect(a!.retry.maxAttempts).toBe(3);
  });

  it("rejects duplicate keys, unknown and self dependencies", () => {
    const r = compileWorkflow(
      wf([
        { key: "a", type: "t" },
        { key: "a", type: "t" },
        { key: "b", type: "t", dependsOn: ["missing", "b"] },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual(
      expect.arrayContaining([
        { code: "duplicate_key", key: "a" },
        { code: "unknown_dependency", key: "b", dependency: "missing" },
        { code: "self_dependency", key: "b" },
      ]),
    );
  });

  it("detects cycles and reports a closed path", () => {
    const r = compileWorkflow(
      wf([
        { key: "a", type: "t", dependsOn: ["c"] },
        { key: "b", type: "t", dependsOn: ["a"] },
        { key: "c", type: "t", dependsOn: ["b"] },
        { key: "d", type: "t" },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const issue = r.issues[0]!;
    expect(issue.code).toBe("cycle");
    if (issue.code !== "cycle") return;
    expect(issue.path[0]).toBe(issue.path[issue.path.length - 1]);
    expect(new Set(issue.path)).toEqual(new Set(["a", "b", "c"]));
    expect(formatDagIssue(issue)).toMatch(/^Dependency cycle: /);
  });

  it("rejects schema violations with a path", () => {
    const r = compileWorkflow({ name: "Bad Name", tasks: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => (i.code === "schema" ? i.path : ""))).toEqual(expect.arrayContaining(["name", "tasks"]));
  });

  it("rejects retry policies whose maxDelay is below initialDelay", () => {
    const r = compileWorkflow(
      wf([
        {
          key: "a",
          type: "t",
          retry: { maxAttempts: 2, initialDelayMs: 5000, maxDelayMs: 10, backoffCoefficient: 2, jitter: 0 },
        },
      ]),
    );
    expect(r.ok).toBe(false);
  });

  it("handles a long chain without recursion limits", () => {
    const tasks = Array.from({ length: 500 }, (_, i) => ({
      key: `t${i}`,
      type: "t",
      dependsOn: i === 0 ? [] : [`t${i - 1}`],
    }));
    const r = compileWorkflow(wf(tasks));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.workflow.levels.t499).toBe(499);
  });
});

describe("graph helpers", () => {
  it("findCycle returns null for a DAG", () => {
    expect(findCycle([{ key: "a", dependsOn: [] }, { key: "b", dependsOn: ["a"] }])).toBeNull();
  });
  it("topologicalOrder throws on a cycle", () => {
    expect(() => topologicalOrder([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }])).toThrow();
  });
});
