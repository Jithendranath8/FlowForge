import { describe, expect, it } from "vitest";
import { DEFAULT_SCHEDULING, selectTasks, type CandidateTask, type SchedulingContext, type WorkerCapacity } from "../src/index.js";

const now = new Date("2026-01-01T00:10:00Z");
let seq = 0;
function task(p: Partial<CandidateTask> = {}): CandidateTask {
  seq += 1;
  return {
    id: p.id ?? `t${String(seq).padStart(3, "0")}`,
    runId: "r1",
    tenantId: "acme",
    taskType: "x",
    queue: "default",
    priority: 0,
    enqueuedAt: now,
    requiredCapabilities: [],
    resources: { cpu: 1, memoryMb: 128 },
    ...p,
  };
}
const worker = (p: Partial<WorkerCapacity> = {}): WorkerCapacity => ({
  queues: ["default"],
  taskTypes: ["x"],
  capabilities: [],
  freeSlots: 10,
  freeCpu: 64,
  freeMemoryMb: 65536,
  ...p,
});
const ctx = (p: Partial<SchedulingContext> = {}): SchedulingContext => ({
  now,
  agingIntervalMs: DEFAULT_SCHEDULING.agingIntervalMs,
  maxAgingBoost: DEFAULT_SCHEDULING.maxAgingBoost,
  runRunning: new Map(),
  runMaxConcurrency: new Map(),
  tenantRunning: new Map(),
  tenantMaxConcurrency: 100,
  ...p,
});
const ids = (r: { selected: CandidateTask[] }) => r.selected.map((t) => t.id);

describe("selectTasks", () => {
  it("orders by priority then FIFO", () => {
    const a = task({ id: "a", priority: 1, enqueuedAt: new Date(now.getTime() - 1000) });
    const b = task({ id: "b", priority: 5 });
    const c = task({ id: "c", priority: 1, enqueuedAt: new Date(now.getTime() - 2000) });
    expect(ids(selectTasks([a, b, c], worker(), ctx()))).toEqual(["b", "c", "a"]);
  });

  it("ages old low-priority work so it is not starved", () => {
    const old = task({ id: "old", priority: 0, enqueuedAt: new Date(now.getTime() - 10 * 60_000) }); // +20
    const fresh = task({ id: "fresh", priority: 10 });
    expect(ids(selectTasks([fresh, old], worker({ freeSlots: 1 }), ctx()))).toEqual(["old"]);
  });

  it("enforces queue and capability constraints", () => {
    const gpu = task({ id: "gpu", requiredCapabilities: ["gpu"] });
    const other = task({ id: "other", queue: "reports" });
    const ok = task({ id: "ok" });
    const r = selectTasks([gpu, other, ok], worker(), ctx());
    expect(ids(r)).toEqual(["ok"]);
    expect(r.rejected.get("gpu")).toBe("missing_capability");
    expect(r.rejected.get("other")).toBe("queue_not_served");
  });

  it("respects slots, cpu and memory", () => {
    const big = task({ id: "big", priority: 9, resources: { cpu: 8, memoryMb: 128 } });
    const fat = task({ id: "fat", priority: 8, resources: { cpu: 1, memoryMb: 9000 } });
    const s1 = task({ id: "s1" });
    const s2 = task({ id: "s2" });
    const r = selectTasks([big, fat, s1, s2], worker({ freeSlots: 1, freeCpu: 4, freeMemoryMb: 4096 }), ctx());
    expect(ids(r)).toEqual(["s1"]);
    expect(r.rejected.get("big")).toBe("insufficient_cpu");
    expect(r.rejected.get("fat")).toBe("insufficient_memory");
    expect(r.rejected.get("s2")).toBe("no_free_slots");
  });

  it("enforces per-run concurrency including tasks already running", () => {
    const r = selectTasks(
      [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })],
      worker(),
      ctx({ runRunning: new Map([["r1", 1]]), runMaxConcurrency: new Map([["r1", 2]]) }),
    );
    expect(ids(r)).toEqual(["a"]);
    expect(r.rejected.get("b")).toBe("run_concurrency_limit");
  });

  it("shares capacity fairly across runs of equal priority", () => {
    const tasks = [
      ...["a1", "a2", "a3", "a4"].map((id) => task({ id, runId: "ra" })),
      ...["b1", "b2"].map((id) => task({ id, runId: "rb" })),
    ];
    const r = selectTasks(tasks, worker({ freeSlots: 4 }), ctx({ runRunning: new Map([["ra", 1]]) }));
    // rb has fewer running tasks so it is served first, then they alternate.
    expect(ids(r)).toEqual(["b1", "a1", "b2", "a2"]);
  });

  it("explicit priority beats fair share", () => {
    const tasks = [task({ id: "hi1", runId: "ra", priority: 5 }), task({ id: "hi2", runId: "ra", priority: 5 }), task({ id: "lo", runId: "rb" })];
    expect(ids(selectTasks(tasks, worker({ freeSlots: 2 }), ctx())).sort()).toEqual(["hi1", "hi2"]);
  });

  it("enforces the tenant concurrency limit", () => {
    const r = selectTasks([task({ id: "a" }), task({ id: "b", runId: "r2" })], worker(), ctx({ tenantRunning: new Map([["acme", 99]]) }));
    expect(ids(r)).toEqual(["a"]);
    expect(r.rejected.get("b")).toBe("tenant_concurrency_limit");
  });

  it("only leases task types the worker registered", () => {
    const r = selectTasks([task({ id: "a", taskType: "unknown" })], worker(), ctx());
    expect(r.rejected.get("a")).toBe("task_type_not_supported");
  });

  it("clamps advisor adjustments and ignores non-finite advice", () => {
    const a = task({ id: "a", priority: 0 });
    const b = task({ id: "b", priority: 15 });
    const advisor = (t: CandidateTask) => (t.id === "a" ? 1_000 : Number.NaN);
    const r = selectTasks([a, b], worker({ freeSlots: 1 }), ctx({ advisor, maxAdvisorAdjustment: 10 }));
    expect(r.scores.get("a")).toBe(10);
    expect(r.scores.get("b")).toBe(15);
    expect(ids(r)).toEqual(["b"]);
  });

  it("never lets the advisor make an ineligible task eligible", () => {
    const gpu = task({ id: "gpu", requiredCapabilities: ["gpu"] });
    const r = selectTasks([gpu], worker(), ctx({ advisor: () => 10 }));
    expect(ids(r)).toEqual([]);
  });
});
