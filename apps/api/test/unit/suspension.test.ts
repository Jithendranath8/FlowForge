import { describe, expect, it } from "vitest";
import { SuspensionDetector, retryIfSuspended } from "../integration/process-harness.js";

/** Block the event loop, as a host suspension does to every process. */
function freeze(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy wait: no timers or I/O can run
  }
}
const tick = () => new Promise((r) => setTimeout(r, 120));

describe("SuspensionDetector", () => {
  it("stays quiet while the process keeps running", async () => {
    const d = new SuspensionDetector();
    for (let i = 0; i < 5; i++) await tick();
    expect(d.suspended()).toBe(false);
    d.stop();
  });

  it("flags a freeze longer than the threshold", { timeout: 30_000 }, async () => {
    const d = new SuspensionDetector();
    await tick();
    freeze(1_700);
    expect(d.maxStallMs()).toBeGreaterThan(1_500);
    expect(d.suspended()).toBe(true);
    d.stop();
  });
});

describe("retryIfSuspended", () => {
  it("re-runs an attempt that failed across a freeze, and returns once one passes", { timeout: 30_000 }, async () => {
    let attempts = 0;
    await retryIfSuspended(3, async () => {
      attempts += 1;
      await tick();
      if (attempts === 1) {
        freeze(1_700);
        throw new Error("lease expired while frozen");
      }
    });
    expect(attempts).toBe(2);
  });

  it("rethrows a failure that had no freeze immediately, without retrying", async () => {
    let attempts = 0;
    const err = await retryIfSuspended(3, async () => {
      attempts += 1;
      await tick();
      throw new Error("real bug");
    }).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect((err as Error).message).toBe("real bug");
  });

  it("reports an explicit inconclusive failure if every attempt was frozen", { timeout: 30_000 }, async () => {
    let attempts = 0;
    const err = (await retryIfSuspended(2, async () => {
      attempts += 1;
      await tick();
      freeze(1_700);
      throw new Error("timing assertion");
    }).catch((e: unknown) => e)) as Error;
    expect(attempts).toBe(2);
    expect(err.message).toMatch(/^Inconclusive: the host was suspended/);
    expect((err.cause as Error).message).toBe("timing assertion");
  });
});
