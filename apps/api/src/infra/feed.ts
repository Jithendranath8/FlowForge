import type { Database } from "@flowforge/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Notifier } from "./notifier.js";

/*
 * Live execution events for the dashboard (ADR-019).
 *
 * The stream carries rows of the `events` table, so Postgres stays the source of truth:
 * each event's id is its SSE id, and a client that reconnects with Last-Event-ID gets
 * exactly what it missed. Redis is only the wake-up: a published event makes the feed
 * read new rows at once, and a poll catches anything Redis dropped (every second while
 * Redis is unhealthy or absent, every few seconds otherwise).
 *
 * One read per tenant serves every subscriber of that tenant in this process: each read
 * fetches rows after the lowest subscriber cursor and hands each subscriber the rows
 * past its own cursor. A subscriber further behind than `maxReplay` events gets a
 * `reset` instead of an unbounded replay, and reloads its view from the API.
 */

export interface StreamEvent {
  id: number;
  type: string;
  runId: string | null;
  taskId: string | null;
  data: unknown;
  createdAt: string;
}

export interface FeedSubscriber {
  /** Events after the subscriber's cursor, in id order. */
  onEvents(events: StreamEvent[]): void;
  /** The subscriber fell too far behind; it should reload state and continue from `cursor`. */
  onReset(cursor: number): void;
}

export interface EventFeedOptions {
  /** Poll interval while Redis is healthy (a safety net for dropped wake-ups). */
  pollMs?: number;
  /** Poll interval while Redis is degraded or not configured. */
  fallbackPollMs?: number;
  /** Rows per read. */
  batch?: number;
  /** Maximum events replayed to a reconnecting subscriber. */
  maxReplay?: number;
}

interface Sub {
  cursor: number;
  target: FeedSubscriber;
}

interface TenantFeed {
  subs: Set<Sub>;
  head: number;
  timer: NodeJS.Timeout | undefined;
  stopListening: () => void;
  reading: Promise<void> | null;
  again: boolean;
}

export class EventFeed {
  private readonly tenants = new Map<string, TenantFeed>();
  private readonly opts: Required<EventFeedOptions>;

  constructor(
    private readonly ctx: { db: Database; notifier: Notifier; log: Pick<Logger, "warn"> },
    opts: EventFeedOptions = {},
  ) {
    this.opts = { pollMs: 5_000, fallbackPollMs: 1_000, batch: 500, maxReplay: 1_000, ...opts };
  }

  /** Open subscriptions in this process (for the metrics gauge and tests). */
  get size(): number {
    let n = 0;
    for (const t of this.tenants.values()) n += t.subs.size;
    return n;
  }

  /**
   * Subscribe to a tenant's events after `after` (an event id), or from now when it is
   * undefined. Returns the unsubscribe function.
   */
  async subscribe(tenantId: string, after: number | undefined, target: FeedSubscriber): Promise<() => void> {
    let feed = this.tenants.get(tenantId);
    if (!feed) {
      const head = await this.latestId(tenantId);
      feed = this.tenants.get(tenantId); // another subscriber may have set it up meanwhile
      if (!feed) {
        const created: TenantFeed = { subs: new Set(), head, timer: undefined, stopListening: () => {}, reading: null, again: false };
        created.stopListening = this.ctx.notifier.onTenantEvent(tenantId, () => this.wake(tenantId));
        this.tenants.set(tenantId, created);
        this.schedule(tenantId, created);
        feed = created;
      }
    }
    let cursor = after ?? feed.head;
    if (feed.head - cursor > this.opts.maxReplay || cursor > feed.head) {
      target.onReset(feed.head);
      cursor = feed.head;
    }
    const sub: Sub = { cursor, target };
    feed.subs.add(sub);
    if (cursor < feed.head) this.wake(tenantId); // replay what it missed
    return () => this.unsubscribe(tenantId, sub);
  }

  private unsubscribe(tenantId: string, sub: Sub): void {
    const feed = this.tenants.get(tenantId);
    if (!feed) return;
    feed.subs.delete(sub);
    if (feed.subs.size === 0) {
      clearTimeout(feed.timer);
      feed.stopListening();
      this.tenants.delete(tenantId);
    }
  }

  /** Stop every subscription's polling (process shutdown). */
  close(): void {
    for (const feed of this.tenants.values()) {
      clearTimeout(feed.timer);
      feed.stopListening();
    }
    this.tenants.clear();
  }

  private schedule(tenantId: string, feed: TenantFeed): void {
    const ms = this.ctx.notifier.healthy() ? this.opts.pollMs : this.opts.fallbackPollMs;
    feed.timer = setTimeout(() => {
      if (this.tenants.get(tenantId) !== feed) return;
      this.wake(tenantId);
      this.schedule(tenantId, feed);
    }, ms);
    feed.timer.unref();
  }

  /** Read new rows now (coalesced: one read in flight per tenant, re-run if woken meanwhile). */
  private wake(tenantId: string): void {
    const feed = this.tenants.get(tenantId);
    if (!feed) return;
    if (feed.reading) {
      feed.again = true;
      return;
    }
    feed.reading = this.drain(tenantId, feed)
      .catch((err: unknown) => this.ctx.log.warn({ err, tenantId }, "event feed read failed; the next poll retries"))
      .finally(() => {
        feed.reading = null;
        if (feed.again) {
          feed.again = false;
          this.wake(tenantId);
        }
      });
  }

  private async drain(tenantId: string, feed: TenantFeed): Promise<void> {
    for (;;) {
      if (feed.subs.size === 0) return;
      const from = Math.min(...[...feed.subs].map((s) => s.cursor));
      const rows = await this.ctx.db.execute<{ id: number; type: string; run_id: string | null; task_id: string | null; data: unknown; created_ms: number }>(sql`
        select id, type, run_id, task_id, data, (extract(epoch from created_at) * 1000)::float8 as created_ms from events
        where tenant_id = ${tenantId} and id > ${from}
        order by id limit ${this.opts.batch}`);
      const events: StreamEvent[] = [...rows].map((r) => ({
        id: Number(r.id),
        type: r.type,
        runId: r.run_id,
        taskId: r.task_id,
        data: r.data,
        createdAt: new Date(Number(r.created_ms)).toISOString(),
      }));
      if (events.length === 0) return;
      const last = events[events.length - 1]!.id;
      feed.head = Math.max(feed.head, last);
      for (const sub of feed.subs) {
        const mine = events.filter((e) => e.id > sub.cursor);
        if (mine.length === 0) continue;
        sub.cursor = mine[mine.length - 1]!.id;
        try {
          sub.target.onEvents(mine);
        } catch (err) {
          this.ctx.log.warn({ err }, "event subscriber failed");
        }
      }
      if (events.length < this.opts.batch) return;
    }
  }

  private async latestId(tenantId: string): Promise<number> {
    const [r] = await this.ctx.db.execute<{ id: number | null }>(sql`select max(id) as id from events where tenant_id = ${tenantId}`);
    return Number(r?.id ?? 0);
  }
}
