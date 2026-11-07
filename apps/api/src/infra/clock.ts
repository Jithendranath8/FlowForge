import type { Database } from "@flowforge/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";

/*
 * Engine time (ADR-015).
 *
 * Every timestamp the engine writes or compares (leases, deadlines, retry times, event
 * and history rows) comes from one function: EngineContext.now(). In production that
 * function follows the database server's clock, which every API replica shares, so
 * replicas agree on lease expiry even when their host clocks disagree. Without this, a
 * replica whose clock runs ahead would reap leases another replica has just granted.
 *
 * DatabaseClock samples `clock_timestamp()` and anchors it to the local monotonic clock:
 *   engine time = server time at the anchor + monotonic time elapsed since the anchor.
 * Between syncs it is immune to local wall-clock steps (NTP corrections, manual changes).
 * Each sync takes several samples and keeps the one with the shortest round trip; half
 * that round trip bounds the error. Engine time never moves backwards within a process,
 * except when the database clock itself steps back by more than `maxBackwardStepMs`.
 */

export interface ClockStats {
  source: "database" | "local";
  /** Engine time minus this host's wall clock, from the latest sync (ms). */
  offsetMs: number;
  /** Half the round trip of the best sample in the latest sync (ms). */
  uncertaintyMs: number;
  /** Monotonic ms since the last successful sync, or null before the first. */
  sinceSyncMs: number | null;
  syncs: number;
  syncFailures: number;
  /** Engine-time correction applied by the latest sync (ms; negative = moved back). */
  lastCorrectionMs: number;
}

export interface EngineClock {
  now(): Date;
  stats(): ClockStats;
  stop(): void;
}

/** The host's wall clock. For single-instance development and tests. */
export class LocalClock implements EngineClock {
  now = (): Date => new Date();
  stats(): ClockStats {
    return { source: "local", offsetMs: 0, uncertaintyMs: 0, sinceSyncMs: null, syncs: 0, syncFailures: 0, lastCorrectionMs: 0 };
  }
  stop(): void {}
}

export interface DatabaseClockOptions {
  /** How often to re-anchor to the database clock. */
  syncIntervalMs: number;
  /** Samples per sync; the shortest round trip wins. */
  samples?: number;
  /** A larger backward correction is applied instead of absorbed. */
  maxBackwardStepMs?: number;
  log?: Pick<Logger, "warn">;
  /** Injectable for tests: monotonic and wall clocks of this host, in ms. */
  monotonic?: () => number;
  wall?: () => number;
}

/** Reads the database server's current time in epoch milliseconds. */
export type ServerTimeSource = () => Promise<number>;

export class DatabaseClock implements EngineClock {
  private anchorServerMs = 0;
  private anchorMono = 0;
  private last = 0;
  private uncertaintyMs = 0;
  private offsetMs = 0;
  private lastCorrectionMs = 0;
  private syncs = 0;
  private syncFailures = 0;
  private timer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> | null = null;
  private readonly mono: () => number;
  private readonly wall: () => number;

  private constructor(
    private readonly source: ServerTimeSource,
    private readonly opts: DatabaseClockOptions,
  ) {
    this.mono = opts.monotonic ?? (() => performance.now());
    this.wall = opts.wall ?? (() => Date.now());
  }

  /** Sync once (throws if the database cannot be read), then re-sync periodically. */
  static async start(source: ServerTimeSource, opts: DatabaseClockOptions): Promise<DatabaseClock> {
    const clock = new DatabaseClock(source, opts);
    await clock.sync();
    clock.schedule();
    return clock;
  }

  now = (): Date => {
    const t = Math.max(this.last, this.anchorServerMs + (this.mono() - this.anchorMono));
    this.last = t;
    return new Date(t);
  };

  /** Re-anchor to the database clock. Concurrent calls share one sync. */
  sync(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const samples = Math.max(1, this.opts.samples ?? 3);
    let best: { rtt: number; serverMs: number; mono: number; wall: number } | null = null;
    try {
      for (let i = 0; i < samples; i++) {
        const t0 = this.mono();
        const serverMs = await this.source();
        const t1 = this.mono();
        if (!Number.isFinite(serverMs)) throw new Error(`database clock returned ${serverMs}`);
        const rtt = t1 - t0;
        // Assume the server read its clock halfway through the round trip.
        if (!best || rtt < best.rtt) best = { rtt, serverMs, mono: (t0 + t1) / 2, wall: this.wall() - (t1 - t0) / 2 };
      }
    } catch (err) {
      this.syncFailures += 1;
      throw err;
    }
    const b = best!;
    const anchored = this.syncs > 0;
    const before = anchored ? this.anchorServerMs + (this.mono() - this.anchorMono) : 0;
    this.anchorServerMs = b.serverMs;
    this.anchorMono = b.mono;
    this.uncertaintyMs = b.rtt / 2;
    this.offsetMs = b.serverMs - b.wall;
    this.syncs += 1;
    if (anchored) {
      this.lastCorrectionMs = this.anchorServerMs + (this.mono() - this.anchorMono) - before;
      const maxBack = this.opts.maxBackwardStepMs ?? 1_000;
      if (this.lastCorrectionMs < -maxBack) {
        // The database clock was stepped back. Follow it rather than freezing engine
        // time until it catches up; leases granted under the old time simply last longer.
        this.last = 0;
        this.opts.log?.warn({ correctionMs: Math.round(this.lastCorrectionMs) }, "database clock stepped backwards; engine time follows it");
      }
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.sync()
        .catch((err: unknown) => this.opts.log?.warn({ err }, "database clock sync failed; keeping the previous anchor"))
        .finally(() => {
          if (this.timer) this.schedule();
        });
    }, this.opts.syncIntervalMs);
    this.timer.unref();
  }

  stats(): ClockStats {
    return {
      source: "database",
      offsetMs: this.offsetMs,
      uncertaintyMs: this.uncertaintyMs,
      sinceSyncMs: this.syncs > 0 ? this.mono() - this.anchorMono : null,
      syncs: this.syncs,
      syncFailures: this.syncFailures,
      lastCorrectionMs: this.lastCorrectionMs,
    };
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * The database server's clock, read through the guarded pool (so a hung database fails
 * the sync within the query deadline). `clock_timestamp()` is the time of the read
 * itself, unlike `now()`, which is fixed at transaction start.
 */
export function postgresTimeSource(db: Database): ServerTimeSource {
  return async () => {
    const rows = await db.execute<{ ms: number }>(sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`);
    return Number([...rows][0]?.ms);
  };
}
