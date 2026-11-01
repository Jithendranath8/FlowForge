import { describe, expect, it } from "vitest";
import {
  assertTaskTransition,
  canTransitionTask,
  checkFence,
  computeBackoffMs,
  decideRetry,
  deriveRunOutcome,
  nextLeaseExpiry,
  resolveDependencies,
  resolveToFixpoint,
  type ResolvableTask,
  type RetryPolicy,
} from "../src/index.js";

describe("task state machine", () => {
  it("allows the happy path and retry loop", () => {
    expect(canTransitionTask("pending", "queued")).toBe(true);
    expect(canTransitionTask("queued", "running")).toBe(true);
    expect(canTransitionTask("running", "retry_scheduled")).toBe(true);
    expect(canTransitionTask("retry_scheduled", "queued")).toBe(true);
    expect(canTransitionTask("running", "succeeded")).toBe(true);
  });
  it("forbids leaving terminal states (except manual retry of failed)", () => {
    expect(() => assertTaskTransition("succeeded", "running")).toThrow(/Illegal task transition/);
    expect(canTransitionTask("skipped", "queued")).toBe(false);
    expect(canTransitionTask("skipped", "pending")).toBe(true);
    expect(canTransitionTask("cancelled", "pending")).toBe(false);
    expect(canTransitionTask("failed", "queued")).toBe(true);
  });
  it("forbids skipping the lease", () => {
    expect(canTransitionTask("queued", "succeeded")).toBe(false);
    expect(canTransitionTask("pending", "running")).toBe(false);
  });
});

describe("run outcome", () => {
  it("is null while work remains", () => expect(deriveRunOutcome(["succeeded", "running"])).toBeNull());
  it("succeeds when all succeeded or skipped", () => expect(deriveRunOutcome(["succeeded", "skipped"])).toBe("succeeded"));
  it("fails if any task failed", () => expect(deriveRunOutcome(["succeeded", "failed", "skipped"])).toBe("failed"));
  it("is cancelled if any task cancelled", () => expect(deriveRunOutcome(["cancelled", "failed"])).toBe("cancelled"));
});

describe("dependency resolution", () => {
  const t = (key: string, state: ResolvableTask["state"], dependsOn: string[] = [], triggerRule: ResolvableTask["triggerRule"] = "all_succeeded"): ResolvableTask => ({ key, state, dependsOn, triggerRule });

  it("queues roots and tasks whose deps all succeeded", () => {
    const r = resolveDependencies([t("a", "succeeded"), t("b", "pending", ["a"]), t("c", "pending", ["a", "b"]), t("r", "pending")]);
    expect(r).toEqual({ toQueue: ["b", "r"], toSkip: [] });
  });

  it("waits while a dependency is retrying", () => {
    const r = resolveDependencies([t("a", "retry_scheduled"), t("b", "pending", ["a"])]);
    expect(r).toEqual({ toQueue: [], toSkip: [] });
  });

  it("applies trigger rules after a failure and cascades skips", () => {
    const states = resolveToFixpoint([
      t("a", "failed"),
      t("b", "pending", ["a"]),
      t("c", "pending", ["b"]),
      t("alert", "pending", ["a"], "any_failed"),
      t("cleanup", "pending", ["a"], "all_done"),
    ]);
    expect(Object.fromEntries(states)).toEqual({ a: "failed", b: "skipped", c: "skipped", alert: "queued", cleanup: "queued" });
  });

  it("is idempotent", () => {
    const tasks = [t("a", "succeeded"), t("b", "queued", ["a"])];
    expect(resolveDependencies(tasks)).toEqual({ toQueue: [], toSkip: [] });
  });
});

describe("retry policy", () => {
  const policy: RetryPolicy = { maxAttempts: 4, initialDelayMs: 1000, maxDelayMs: 5000, backoffCoefficient: 2, jitter: 0 };
  it("grows exponentially and caps", () => {
    expect([1, 2, 3, 4, 5].map((a) => computeBackoffMs(policy, a))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
  it("jitter only reduces the delay", () => {
    const p = { ...policy, jitter: 0.5 };
    expect(computeBackoffMs(p, 3, () => 1)).toBe(2000);
    expect(computeBackoffMs(p, 3, () => 0)).toBe(4000);
  });
  it("stops after maxAttempts and on non-retryable errors", () => {
    expect(decideRetry(policy, 3, "error").retry).toBe(true);
    expect(decideRetry(policy, 4, "error")).toEqual({ retry: false, delayMs: 0 });
    expect(decideRetry(policy, 1, "non_retryable").retry).toBe(false);
    expect(decideRetry(policy, 1, "lease_expired")).toEqual({ retry: true, delayMs: 1000 });
  });
  it("rejects invalid attempts", () => expect(() => computeBackoffMs(policy, 0)).toThrow(RangeError));
});

describe("leases and fencing", () => {
  const now = new Date("2026-01-01T00:00:10Z");
  const lease = { running: true, fence: 7, workerId: "w1", leaseExpiresAt: new Date("2026-01-01T00:00:20Z") };
  it("accepts the current owner", () => expect(checkFence(lease, { fence: 7, workerId: "w1" }, now)).toEqual({ ok: true }));
  it("rejects a stale fence after re-lease", () => expect(checkFence(lease, { fence: 6, workerId: "w1" }, now)).toEqual({ ok: false, reason: "stale_fence" }));
  it("rejects another worker", () => expect(checkFence(lease, { fence: 7, workerId: "w2" }, now)).toEqual({ ok: false, reason: "not_owner" }));
  it("rejects an expired lease", () =>
    expect(checkFence(lease, { fence: 7, workerId: "w1" }, new Date("2026-01-01T00:00:20Z"))).toEqual({ ok: false, reason: "lease_expired" }));
  it("rejects a task no longer running", () =>
    expect(checkFence({ ...lease, running: false }, { fence: 7, workerId: "w1" }, now)).toEqual({ ok: false, reason: "not_running" }));
  it("never renews past the attempt deadline", () => {
    const deadline = new Date("2026-01-01T00:00:15Z");
    expect(nextLeaseExpiry(now, 30_000, deadline)).toEqual(deadline);
    expect(nextLeaseExpiry(now, 1_000, deadline)).toEqual(new Date("2026-01-01T00:00:11Z"));
  });
});
