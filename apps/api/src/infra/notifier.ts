import { Redis } from "ioredis";
import type { Logger } from "pino";

/**
 * Redis is used only for ephemeral signalling: waking long-polling workers when tasks
 * are queued and streaming live events to dashboards. Postgres remains authoritative.
 * If Redis is absent or down, waits fall back to short polling intervals, so delivery
 * latency degrades but correctness does not.
 */
export interface Notifier {
  readonly enabled: boolean;
  healthy(): boolean;
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
  async publishEvents() {}
  waitForWork(_t: string, _q: string[], timeoutMs: number, signal?: AbortSignal) {
    return sleep(Math.min(timeoutMs, FALLBACK_POLL_MS), signal);
  }
  onTenantEvent() {
    return () => {};
  }
  async close() {}
}

export class RedisNotifier implements Notifier {
  readonly enabled = true;
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  constructor(
    url: string,
    private readonly log: Logger,
  ) {
    const opts = {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      retryStrategy: (n: number) => Math.min(n * 200, 5_000),
    };
    this.pub = new Redis(url, opts);
    // The subscriber queues its psubscribe until connected and re-subscribes on reconnect.
    this.sub = new Redis(url, { ...opts, enableOfflineQueue: true });
    for (const [name, c] of [
      ["pub", this.pub],
      ["sub", this.sub],
    ] as const) {
      c.on("error", (err: Error) => this.log.warn({ err: err.message, client: name }, "redis error"));
    }
    void this.sub.psubscribe("ff:t:*").catch((err: Error) => this.log.warn({ err: err.message }, "redis psubscribe failed"));
    this.sub.on("pmessage", (_pattern: string, channel: string, message: string) => this.dispatch(channel, message));
  }

  healthy(): boolean {
    return this.pub.status === "ready" && this.sub.status === "ready";
  }

  async publishEvents(rows: Parameters<Notifier["publishEvents"]>[0]): Promise<void> {
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
    for (const set of this.waiters.values()) for (const wake of [...set]) wake();
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

export function createNotifier(url: string | undefined, log: Logger): Notifier {
  return url ? new RedisNotifier(url, log) : new NullNotifier();
}
