import { describe, expect, it, vi } from "vitest";
import { DatabaseClock, LocalClock } from "../../src/infra/clock.js";

/**
 * A simulated host: `mono` is its monotonic clock, `wall` its (possibly skewed or
 * stepped) wall clock, and `server` the database server's clock. Each sample advances
 * the monotonic clock by the given round trip and reports the server time at its midpoint.
 */
function host(opts: { serverMs: number; wallOffsetMs?: number }) {
  const h = {
    mono: 1_000,
    wallOffsetMs: opts.wallOffsetMs ?? 0,
    serverAtMono0: opts.serverMs - 1_000,
    rtts: [] as number[],
    fail: false,
    monotonic: () => h.mono,
    wall: () => h.serverAtMono0 + h.mono + h.wallOffsetMs,
    source: async () => {
      if (h.fail) throw new Error("database unavailable");
      const rtt = h.rtts.shift() ?? 2;
      h.mono += rtt / 2;
      const read = h.serverAtMono0 + h.mono;
      h.mono += rtt / 2;
      return read;
    },
    elapse: (ms: number) => void (h.mono += ms),
  };
  return h;
}

const T0 = Date.parse("2026-06-01T12:00:00.000Z");

describe("DatabaseClock", () => {
  it("follows the server clock plus monotonic time elapsed, whatever the host wall clock says", async () => {
    const h = host({ serverMs: T0, wallOffsetMs: -113_000 }); // host clock 1m53s behind (as observed in the audit)
    const clock = await DatabaseClock.start(h.source, { syncIntervalMs: 60_000, samples: 1, monotonic: h.monotonic, wall: h.wall });
    try {
      expect(clock.now().getTime()).toBe(T0 + 2); // read at the midpoint of a 2 ms round trip, 1 ms ago
      h.elapse(5_000);
      expect(clock.now().getTime()).toBe(T0 + 5_002);
      h.wallOffsetMs += 3_600_000; // the host clock jumps an hour (NTP step, manual change)
      h.elapse(1_000);
      expect(clock.now().getTime()).toBe(T0 + 6_002);
      expect(clock.stats()).toMatchObject({ source: "database", offsetMs: 113_000, uncertaintyMs: 1, syncs: 1, syncFailures: 0 });
    } finally {
      clock.stop();
    }
  });

  it("two replicas with different host clocks agree on engine time", async () => {
    const a = host({ serverMs: T0, wallOffsetMs: 0 });
    const b = host({ serverMs: T0, wallOffsetMs: 45_000 }); // 45 s ahead: would reap A's leases early
    const ca = await DatabaseClock.start(a.source, { syncIntervalMs: 60_000, samples: 1, monotonic: a.monotonic, wall: a.wall });
    const cb = await DatabaseClock.start(b.source, { syncIntervalMs: 60_000, samples: 1, monotonic: b.monotonic, wall: b.wall });
    try {
      expect(cb.now().getTime() - ca.now().getTime()).toBe(0);
      expect(cb.stats().offsetMs - ca.stats().offsetMs).toBe(-45_000);
    } finally {
      ca.stop();
      cb.stop();
    }
  });

  it("anchors on the sample with the shortest round trip and reports half of it as uncertainty", async () => {
    const h = host({ serverMs: T0 });
    h.rtts = [80, 6, 40];
    const clock = await DatabaseClock.start(h.source, { syncIntervalMs: 60_000, samples: 3, monotonic: h.monotonic, wall: h.wall });
    try {
      expect(clock.stats().uncertaintyMs).toBe(3);
      // Exact: the simulated server read its clock at the midpoint of every sample.
      expect(clock.now().getTime()).toBe(h.serverAtMono0 + h.mono);
    } finally {
      clock.stop();
    }
  });

  it("never moves backwards for small corrections, and follows a large backward step", async () => {
    const log = { warn: vi.fn() };
    const h = host({ serverMs: T0 });
    const clock = await DatabaseClock.start(h.source, { syncIntervalMs: 60_000, samples: 1, maxBackwardStepMs: 1_000, monotonic: h.monotonic, wall: h.wall, log });
    try {
      h.elapse(10_000);
      const before = clock.now().getTime();
      h.serverAtMono0 -= 400; // the server clock is slewed back 400 ms
      await clock.sync();
      expect(clock.stats().lastCorrectionMs).toBe(-400);
      expect(clock.now().getTime()).toBe(before); // held, not moved back
      h.elapse(300);
      expect(clock.now().getTime()).toBe(before); // still catching up
      h.elapse(200);
      // -400 correction, +2 ms for the sync's own round trip, +500 ms elapsed.
      expect(clock.now().getTime()).toBe(before + 102);

      h.serverAtMono0 -= 3_600_000; // the server clock is stepped back an hour
      const beforeStep = clock.now().getTime();
      await clock.sync();
      expect(clock.now().getTime()).toBeLessThan(beforeStep - 3_590_000);
      expect(log.warn).toHaveBeenCalledOnce();
    } finally {
      clock.stop();
    }
  });

  it("fails to start without a database, and keeps its anchor through later sync failures", async () => {
    const h = host({ serverMs: T0 });
    h.fail = true;
    await expect(DatabaseClock.start(h.source, { syncIntervalMs: 60_000, monotonic: h.monotonic, wall: h.wall })).rejects.toThrow(/unavailable/);

    h.fail = false;
    const clock = await DatabaseClock.start(h.source, { syncIntervalMs: 60_000, samples: 1, monotonic: h.monotonic, wall: h.wall });
    try {
      const t = clock.now().getTime();
      h.fail = true;
      await expect(clock.sync()).rejects.toThrow(/unavailable/);
      h.elapse(1_000);
      expect(clock.now().getTime()).toBe(t + 1_000);
      expect(clock.stats()).toMatchObject({ syncs: 1, syncFailures: 1 });
    } finally {
      clock.stop();
    }
  });

  it("rejects a non-numeric server time", async () => {
    await expect(DatabaseClock.start(async () => Number.NaN, { syncIntervalMs: 60_000 })).rejects.toThrow(/returned NaN/);
  });

  it("shares one sync between concurrent callers", async () => {
    const h = host({ serverMs: T0 });
    let reads = 0;
    const source = async () => {
      reads += 1;
      return h.source();
    };
    const clock = await DatabaseClock.start(source, { syncIntervalMs: 60_000, samples: 2, monotonic: h.monotonic, wall: h.wall });
    try {
      reads = 0;
      await Promise.all([clock.sync(), clock.sync(), clock.sync()]);
      expect(reads).toBe(2);
      expect(clock.stats().syncs).toBe(2);
    } finally {
      clock.stop();
    }
  });

  it("re-syncs periodically until stopped, logging failed syncs", async () => {
    const log = { warn: vi.fn() };
    let n = 0;
    const clock = await DatabaseClock.start(
      async () => {
        n += 1;
        if (n === 3) throw new Error("blip");
        return Date.now();
      },
      { syncIntervalMs: 20, samples: 1, log },
    );
    await new Promise((r) => setTimeout(r, 200));
    clock.stop();
    const syncs = clock.stats().syncs;
    expect(syncs).toBeGreaterThan(2);
    expect(clock.stats().syncFailures).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/sync failed/));
    await new Promise((r) => setTimeout(r, 80));
    expect(clock.stats().syncs).toBe(syncs);
  });
});

describe("LocalClock", () => {
  it("is the host clock", () => {
    const c = new LocalClock();
    const t = Date.now();
    expect(Math.abs(c.now().getTime() - t)).toBeLessThan(50);
    expect(c.stats()).toMatchObject({ source: "local", syncs: 0 });
    c.stop();
  });
});
