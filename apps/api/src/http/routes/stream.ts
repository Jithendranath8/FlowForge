import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { rateLimited } from "../../errors.js";
import type { EventFeed, StreamEvent } from "../../infra/feed.js";
import { metrics } from "../../infra/metrics.js";
import { requireScope } from "../auth.js";
import { parse } from "../validation.js";

/*
 * GET /v1/stream: live execution events as Server-Sent Events (ADR-019).
 *
 * - Event ids are `events.id`; reconnecting with Last-Event-ID (EventSource does this by
 *   itself) or ?after= resumes exactly where the client left off.
 * - ?runId= limits the stream to one run's events.
 * - `event: reset` means the client is too far behind to replay: reload, then continue.
 * - A comment line every HEARTBEAT_MS keeps proxies from closing an idle stream; the
 *   server ends each stream after MAX_STREAM_MS so the client reconnects.
 * - While open, the stream re-checks its credential every RECHECK_MS: a revoked key, an
 *   ended session, a removed member, an email taken off the allowlist or a switch to
 *   another workspace ends it then, not at the end of its lifetime.
 */

export interface StreamOptions {
  heartbeatMs?: number;
  maxStreamMs?: number;
  /** Concurrent streams per tenant in this process. */
  maxPerTenant?: number;
  /** How often an open stream re-checks its credential (default 30 s). */
  recheckMs?: number;
}

/** Re-authenticates an open stream's request; true while it may still read this tenant. */
export type StreamRecheck = (req: FastifyRequest, tenantId: string) => Promise<boolean>;

const StreamQuery = z.object({
  runId: z.uuid().optional(),
  after: z.coerce.number().int().min(0).optional(),
});

export function streamRoutes(app: FastifyInstance, feed: EventFeed, opts: StreamOptions = {}, recheck?: StreamRecheck) {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const recheckMs = opts.recheckMs ?? 30_000;
  const maxStreamMs = opts.maxStreamMs ?? 30 * 60_000;
  const maxPerTenant = opts.maxPerTenant ?? 50;
  const open = new Map<string, number>();
  const closers = new Set<() => void>();
  // Streams never finish on their own: end them before the server stops, or a graceful
  // shutdown would wait on every open dashboard.
  app.addHook("preClose", async () => {
    for (const close of [...closers]) close();
  });

  app.get("/stream", async (req, reply) => {
    const p = requireScope(req, "read");
    const q = parse(StreamQuery, req.query);
    const header = req.headers["last-event-id"];
    const lastId = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : q.after;
    const count = open.get(p.tenantId) ?? 0;
    // Slots free as tabs close and streams reach their lifetime; 30 s is a reasonable wait.
    if (count >= maxPerTenant) throw rateLimited("too_many_streams", `At most ${maxPerTenant} live streams per workspace`, 30_000, { limit: maxPerTenant });

    const out = new PassThrough();
    const write = (chunk: string) => {
      if (!out.writableEnded) out.write(chunk);
    };
    const send = (e: StreamEvent) => {
      if (q.runId && e.runId !== q.runId) return;
      write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    open.set(p.tenantId, count + 1);
    metrics.sseStreams.inc();
    let closed = false;
    let unsubscribe: () => void = () => {};
    const heartbeat = setInterval(() => write(`: ping\n\n`), heartbeatMs);
    const lifetime = setTimeout(() => close(), maxStreamMs);
    let checking = false;
    const recheckTimer = recheck
      ? setInterval(() => {
          if (checking || closed) return;
          checking = true;
          recheck(req, p.tenantId)
            .catch(() => false)
            .then((ok) => {
              checking = false;
              if (!ok) close(); // the client reconnects, and is refused if access really ended
            });
        }, recheckMs)
      : undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      closers.delete(close);
      clearInterval(heartbeat);
      clearInterval(recheckTimer);
      clearTimeout(lifetime);
      unsubscribe();
      const n = (open.get(p.tenantId) ?? 1) - 1;
      if (n > 0) open.set(p.tenantId, n);
      else open.delete(p.tenantId);
      metrics.sseStreams.dec();
      out.end();
    };
    req.raw.on("close", close);
    closers.add(close);

    write(`retry: 3000\n\n`);
    try {
      unsubscribe = await feed.subscribe(p.tenantId, lastId, {
        onEvents: (events) => events.forEach(send),
        onReset: (cursor) => write(`id: ${cursor}\nevent: reset\ndata: ${JSON.stringify({ cursor })}\n\n`),
      });
    } catch (err) {
      close();
      throw err;
    }
    if (closed) unsubscribe(); // the client left while we subscribed

    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("x-accel-buffering", "no")
      .send(out);
  });
}
