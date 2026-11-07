import { Redis } from "ioredis";
import type { Logger } from "pino";

/**
 * Redis is used only for ephemeral signalling: waking long-polling workers when tasks
 * are queued and streaming live events to dashboards. Postgres remains authoritative.
 * If Redis is absent or down, waits fall back to short polling intervals, so delivery
 * latency degrades but correctness does not.
 */
export interface NotifierHealth {
  status: "not_configured" | "ok" | "degraded";
  /** Last successful round-trip (health ping or publish), ISO time. */
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface Notifier {
  readonly enabled: boolean;
  /** True only if both connections are up and a round-trip succeeded recently. */
  healthy(): boolean;
  health(): NotifierHealth;
  publishEvents(rows: { tenantId: string; payload: { type: string; data: Record<string, unknown> } }[]): Promise<void>;
  /** Resolve when work may be available on one of the queues, or after timeoutMs. */
  waitForWork(tenantId: string, queues: string[], timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Live events for a tenant (dashboard streaming). Returns an unsubscribe function. */
  onTenantEvent(tenantId: string, cb: (event: unknown) => void): () => void;
  close(): Promise<void>;
}

/** Maximum wait when no push signal is available; bounds pickup latency without Redis. */
export const FALLBACK_POLL_MS = 1_000;

const queueChannel = (tenantId: string, queue: string) => `ff:t:${tenantId}:q:${queue}`;
const eventsChannel = (tenantId: string) => `ff:t:${tenantId}:events`;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class NullNotifier implements Notifier {
  readonly enabled = false;
  healthy() {
    return false;
  }
  health(): NotifierHealth {
    return { status: "not_configured", lastOkAt: null, lastError: null, consecutiveFailures: 0 };
  }
  async publishEvents() {}
  waitForWork(_t: string, _q: string[], timeoutMs: number, signal?: AbortSignal) {
    return sleep(Math.min(timeoutMs, FALLBACK_POLL_MS), signal);
  }
  onTenantEvent() {
    return () => {};
  }
  async close() {}
}

export interface RedisNotifierOptions {
  /** Per-command deadline. A hung server fails commands instead of blocking callers. */
  commandTimeoutMs: number;
  /** How often both connections are PINGed to keep `healthy()` truthful. */
  healthIntervalMs: number;
}

export const DEFAULT_REDIS_OPTIONS: RedisNotifierOptions = { commandTimeoutMs: 1_000, healthIntervalMs: 1_000 };

export class RedisNotifier implements Notifier {
  readonly enabled = true;
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
  private readonly prober: NodeJS.Timeout;
  private probing = false;
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(
    url: string,
    private readonly log: Logger,
    private readonly opts: RedisNotifierOptions = DEFAULT_REDIS_OPTIONS,
  ) {
    const clientOpts = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      commandTimeout: opts.commandTimeoutMs,
      retryStrategy: (n: number) => Math.min(n * 200, 5_000),
    };
    this.pub = new Redis(url, clientOpts);
    // The subscriber queues its psubscribe until connected and re-subscribes on reconnect.
    this.sub = new Redis(url, { ...clientOpts, enableOfflineQueue: true });
    for (const [name, c] of [
      ["pub", this.pub],
      ["sub", this.sub],
    ] as const) {
      c.on("error", (err: Error) => this.log.warn({ err: err.message, client: name }, "redis error"));
      c.on("ready", () => void this.probe());
    }
    void this.sub.psubscribe("ff:t:*").catch((err: Error) => this.log.warn({ err: err.message }, "redis psubscribe failed"));
    this.sub.on("pmessage", (_pattern: string, channel: string, message: string) => this.dispatch(channel, message));
    this.prober = setInterval(() => void this.probe(), opts.healthIntervalMs);
    this.prober.unref();
  }

  /**
   * Socket state alone is not enough: a hung server keeps its sockets "ready" while every
   * command stalls. Health therefore also requires a recent successful round-trip and no
   * failure since.
   */
  healthy(): boolean {
    if (this.pub.status !== "ready" || this.sub.status !== "ready") return false;
    if (this.consecutiveFailures > 0 || this.lastOkAt === null) return false;
    return Date.now() - this.lastOkAt <= this.opts.healthIntervalMs * 3 + this.opts.commandTimeoutMs;
  }

  health(): NotifierHealth {
    return {
      status: this.healthy() ? "ok" : "degraded",
      lastOkAt: this.lastOkAt === null ? null : new Date(this.lastOkAt).toISOString(),
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      await Promise.all([this.pub.ping(), this.sub.ping()]);
      this.markOk();
    } catch (err) {
      this.markFailure(err);
    } finally {
      this.probing = false;
    }
  }

  private markOk() {
    this.lastOkAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private markFailure(err: unknown) {
    this.consecutiveFailures += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  async publishEvents(rows: Parameters<Notifier["publishEvents"]>[0]): Promise<void> {
    try {
      await this.publishPipeline(rows);
      this.markOk();
    } catch (err) {
      this.markFailure(err);
      throw err;
    }
  }

  private async publishPipeline(rows: Parameters<Notifier["publishEvents"]>[0]): Promise<void> {
    const pipeline = this.pub.pipeline();
    const woken = new Set<string>();
    for (const r of rows) {
      pipeline.publish(eventsChannel(r.tenantId), JSON.stringify(r.payload));
      if (r.payload.type === "task.queued" && typeof r.payload.data.queue === "string") {
        const ch = queueChannel(r.tenantId, r.payload.data.queue);
        if (!woken.has(ch)) {
          woken.add(ch);
          pipeline.publish(ch, "1");
        }
      }
    }
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  waitForWork(tenantId: string, queues: string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const wait = this.healthy() ? timeoutMs : Math.min(timeoutMs, FALLBACK_POLL_MS);
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const channels = queues.map((q) => queueChannel(tenantId, q));
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        for (const ch of channels) {
          const set = this.waiters.get(ch);
          set?.delete(finish);
          if (set && set.size === 0) this.waiters.delete(ch);
        }
        resolve();
      };
      const timer = setTimeout(finish, wait);
      for (const ch of channels) {
        const set = this.waiters.get(ch) ?? new Set();
        set.add(finish);
        this.waiters.set(ch, set);
      }
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  onTenantEvent(tenantId: string, cb: (event: unknown) => void): () => void {
    const ch = eventsChannel(tenantId);
    const set = this.listeners.get(ch) ?? new Set();
    set.add(cb);
    this.listeners.set(ch, set);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(ch);
    };
  }

  private dispatch(channel: string, message: string) {
    for (const wake of [...(this.waiters.get(channel) ?? [])]) wake();
    const listeners = this.listeners.get(channel);
    if (!listeners?.size) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    for (const cb of listeners) cb(parsed);
  }

  async close(): Promise<void> {
    clearInterval(this.prober);
    for (const set of this.waiters.values()) for (const wake of [...set]) wake();
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

export function createNotifier(url: string | undefined, log: Logger, opts: RedisNotifierOptions = DEFAULT_REDIS_OPTIONS): Notifier {
  return url ? new RedisNotifier(url, log, opts) : new NullNotifier();
}
