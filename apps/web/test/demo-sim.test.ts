import { describe, expect, it } from "vitest";
import { BACKOFF_TICKS, LEASE_TICKS, armFailure, crashWorker, initialState, runToEnd, step, type SimState } from "../src/lib/demo-sim";

const until = (s: SimState, cond: (s: SimState) => boolean, limit = 500) => {
  let cur = s;
  for (let i = 0; i < limit && !cond(cur); i++) cur = step(cur);
  if (!cond(cur)) throw new Error("condition never met");
  return cur;
};

describe("demo simulation", () => {
  it("runs the workflow to success, honouring dependencies, and skips the any_failed task", () => {
    const end = runToEnd(initialState());
    expect(end.run).toBe("succeeded");
    expect(Object.fromEntries(Object.entries(end.tasks).map(([k, t]) => [k, t.state]))).toEqual({
      extract: "succeeded",
      clean: "succeeded",
      enrich: "succeeded",
      load: "succeeded",
      notify: "skipped",
    });
    const started = (k: string) => end.attempts.find((a) => a.task === k)!.start;
    const ended = (k: string) => end.attempts.find((a) => a.task === k)!.end!;
    expect(started("clean")).toBeGreaterThanOrEqual(ended("extract"));
    expect(started("load")).toBeGreaterThanOrEqual(Math.max(ended("clean"), ended("enrich")));
    // clean and enrich ran in parallel, on different workers.
    const c = end.attempts.find((a) => a.task === "clean")!;
    const e = end.attempts.find((a) => a.task === "enrich")!;
    expect(c.worker).not.toBe(e.worker);
    expect(c.start).toBe(e.start);
  });

  it("recovers a task from a crashed worker after its lease expires, with a new fence", () => {
    let s = until(initialState(), (x) => x.tasks.extract!.state === "running");
    const victim = s.tasks.extract!.worker!;
    s = crashWorker(step(s), victim);
    const crashedAt = s.tick;
    s = until(s, (x) => x.tasks.extract!.state === "retry_scheduled");
    expect(s.tick - crashedAt).toBeLessThanOrEqual(LEASE_TICKS);
    expect(s.attempts[0]).toMatchObject({ task: "extract", worker: victim, outcome: "lease_expired" });
    s = until(s, (x) => x.tasks.extract!.state === "running");
    expect(s.tick - crashedAt).toBeLessThanOrEqual(LEASE_TICKS + BACKOFF_TICKS + 1);
    expect(s.tasks.extract!.worker).not.toBe(victim);
    expect(s.tasks.extract!.fence).toBe(2);
    const end = runToEnd(s);
    expect(end.run).toBe("succeeded");
    expect(end.log.some((l) => /reports extract \(fence 1\); rejected, the current fence is 2/.test(l.text))).toBe(true);
  });

  it("retries an attempt that fails, and the run still succeeds", () => {
    let s = until(initialState(), (x) => x.tasks.extract!.state === "running");
    s = armFailure(s);
    expect(armFailure(s)).toBe(s); // already armed
    const end = runToEnd(s);
    expect(end.run).toBe("succeeded");
    expect(end.attempts.filter((a) => a.task === "extract").map((a) => a.outcome)).toEqual(["failed", "succeeded"]);
    expect(end.tasks.notify!.state).toBe("skipped"); // extract succeeded in the end
  });

  it("is deterministic, and ignores actions once the run is over", () => {
    expect(runToEnd(initialState())).toEqual(runToEnd(initialState()));
    const end = runToEnd(initialState());
    expect(step(end)).toBe(end);
    expect(crashWorker(end, "worker-1")).toBe(end);
    expect(armFailure(end)).toBe(end);
  });
});
