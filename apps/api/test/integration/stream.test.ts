import { schema, type DbHandle } from "@flowforge/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { relayOutbox } from "../../src/engine/maintenance.js";
import { cancelRun, submitRun } from "../../src/engine/runs.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { buildApp } from "../../src/http/app.js";
import type { StreamOptions } from "../../src/http/routes/stream.js";
import { EventFeed, type EventFeedOptions } from "../../src/infra/feed.js";
import { metrics } from "../../src/infra/metrics.js";
import { RedisNotifier, type Notifier } from "../../src/infra/notifier.js";
import { REDIS_TEST_URL, TestClock, createApiKey, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";
import { waitUntil } from "./process-harness.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* GET /v1/stream over a real socket, parsed as Server-Sent Events. */

let h: DbHandle;
let ctx: EngineContext;
let app: FastifyInstance;
let feed: EventFeed;
let base: string;
let tenant: string;
let key: string;
const clients: SseClient[] = [];

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  for (const c of clients.splice(0)) c.close();
  app?.server.closeAllConnections();
  await app?.close();
  feed?.close();
  await h?.close();
});
beforeEach(async () => {
  await start();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
});

async function start(opts: { notifier?: Notifier; feed?: EventFeedOptions; stream?: StreamOptions } = {}) {
  for (const c of clients.splice(0)) c.close();
  // The test's fetch client can leave pooled sockets the server counts as busy, which
  // would make close() wait for the keep-alive timeout. Production shutdown with open
  // streams is covered by observability.test.ts (SIGTERM exits promptly).
  app?.server.closeAllConnections();
  await app?.close();
  feed?.close();
  await resetData(h);
  ctx = makeContext(h, new TestClock(), opts.notifier);
  feed = new EventFeed(ctx, { pollMs: 50, fallbackPollMs: 50, ...opts.feed });
  app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" }, ctx, feed, stream: opts.stream });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
  tenant = await createTenant(h, "acme");
  key = await createApiKey(h, tenant, ["read"]);
  await registerWorkflow(ctx, tenant, { name: "wf", tasks: [{ key: "a", type: "t" }] });
}

interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

class SseClient {
  readonly messages: SseMessage[] = [];
  status = 0;
  retryAfter: string | null = null;
  ended = false;
  private abort = new AbortController();
  private buffer = "";

  static async open(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const c = new SseClient();
    clients.push(c);
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}`, ...headers }, signal: c.abort.signal });
    c.status = res.status;
    c.retryAfter = res.headers.get("retry-after");
    if (res.ok && res.body) void c.read(res.body);
    else {
      await res.text(); // release the connection
      c.ended = true;
    }
    return c;
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body) {
        this.buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = this.buffer.indexOf("\n\n")) >= 0) {
          const block = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 2);
          const m: SseMessage = {};
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) m.comment = line.slice(1).trim();
            else {
              const [k, ...v] = line.split(": ");
              (m as Record<string, string>)[k!] = v.join(": ");
            }
          }
          this.messages.push(m);
        }
      }
    } catch {
      // aborted
    }
    this.ended = true;
  }

  events(): { id: number; event?: string; runId?: string | null; [k: string]: unknown }[] {
    return this.messages.filter((m) => m.data && m.event !== "reset").map((m) => ({ id: Number(m.id), event: m.event, ...(JSON.parse(m.data!) as Record<string, unknown>) }));
  }

  close() {
    this.abort.abort();
  }
}

const until = (cond: () => boolean, what: string, ms = 5_000) => waitUntil(cond, ms, what);
const run = () => submitRun(ctx, tenant, { workflow: "wf", triggeredBy: "test" });

describe("live event stream", () => {
  it("streams a tenant's new events in order, with their ids", async () => {
    const c = await SseClient.open("/v1/stream");
    expect(c.status).toBe(200);
    const r = await run();
    await cancelRun(ctx, tenant, r.run.id, "test");
    await until(() => c.events().length >= 4, "4 events");
    const ev = c.events();
    expect(ev.map((e) => e.event)).toEqual(["run.created", "task.queued", "task.cancelled", "run.cancelled"]);
    expect(ev.every((e, i) => i === 0 || e.id > ev[i - 1]!.id)).toBe(true);
    expect(ev[0]).toMatchObject({ runId: r.run.id, type: "run.created", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(c.messages[0]).toEqual({ retry: "3000" });
  });

  it("resumes exactly after Last-Event-ID, and resets a client too far behind", async () => {
    for (let i = 0; i < 3; i++) await run(); // 6 events
    const first = await SseClient.open("/v1/stream?after=0");
    await until(() => first.events().length === 6, "replay of all 6");
    const ids = first.events().map((e) => e.id);
    const resumed = await SseClient.open("/v1/stream", { "last-event-id": String(ids[3]) });
    await until(() => resumed.events().length === 2, "the 2 after the 4th");
    expect(resumed.events().map((e) => e.id)).toEqual(ids.slice(4));

    await start({ feed: { maxReplay: 3 } });
    for (let i = 0; i < 3; i++) await run();
    const behind = await SseClient.open("/v1/stream?after=0");
    await until(() => behind.messages.some((m) => m.event === "reset"), "reset");
    const reset = behind.messages.find((m) => m.event === "reset")!;
    expect(JSON.parse(reset.data!).cursor).toBe(Number(reset.id));
    await run();
    await until(() => behind.events().length === 2, "events after the reset");
  });

  it("filters to one run, and never crosses tenants", async () => {
    const r1 = await run();
    const filtered = await SseClient.open(`/v1/stream?runId=${r1.run.id}`);
    const all = await SseClient.open("/v1/stream");
    const other = await createTenant(h, "other");
    await registerWorkflow(ctx, other, { name: "wf", tasks: [{ key: "a", type: "t" }] });
    await submitRun(ctx, other, { workflow: "wf", triggeredBy: "test" });
    const r2 = await run();
    await cancelRun(ctx, tenant, r1.run.id, "test");
    await until(() => all.events().length >= 4 && filtered.events().length >= 2, "events");
    await new Promise((r) => setTimeout(r, 200));
    expect(new Set(filtered.events().map((e) => e.runId))).toEqual(new Set([r1.run.id]));
    expect(new Set(all.events().map((e) => e.runId))).toEqual(new Set([r1.run.id, r2.run.id]));
  });

  it("wakes on the Redis notification, not only the poll", async () => {
    const notifier = new RedisNotifier(REDIS_TEST_URL, pino({ level: "silent" }));
    try {
      await waitUntil(() => notifier.healthy(), 5_000, "redis healthy");
      await start({ notifier, feed: { pollMs: 60_000, fallbackPollMs: 60_000 } });
      const c = await SseClient.open("/v1/stream");
      await new Promise((r) => setTimeout(r, 200)); // subscribed
      await run();
      const t0 = performance.now();
      await relayOutbox(ctx); // publishes the outbox rows to Redis
      await until(() => c.events().length === 2, "events via the Redis wake-up", 3_000);
      expect(performance.now() - t0).toBeLessThan(3_000); // the poll is a minute away
    } finally {
      await app.close();
      await notifier.close();
      await start();
    }
  });

  it("requires read access, caps streams per tenant, and cleans up on disconnect", async () => {
    const r401 = await fetch(`${base}/v1/stream`);
    await r401.text();
    expect(r401.status).toBe(401);
    const workerKey = await createApiKey(h, tenant, ["worker"]);
    const r403 = await fetch(`${base}/v1/stream`, { headers: { authorization: `Bearer ${workerKey}` } });
    await r403.text();
    expect(r403.status).toBe(403);

    await start({ stream: { maxPerTenant: 2 } });
    const gauge = async () => (await metrics.sseStreams.get()).values[0]!.value;
    const before = await gauge();
    const a = await SseClient.open("/v1/stream");
    const b = await SseClient.open("/v1/stream");
    const c = await SseClient.open("/v1/stream");
    expect([a.status, b.status, c.status]).toEqual([200, 200, 429]);
    expect(c.retryAfter).toBe("30"); // like every other 429, it says when to try again
    expect(feed.size).toBe(2);
    expect(await gauge()).toBe(before + 2);
    a.close();
    b.close();
    await until(() => feed.size === 0, "subscriptions released");
    expect(await gauge()).toBe(before);
    expect((await SseClient.open("/v1/stream")).status).toBe(200); // capacity is back
  });

  it("sends heartbeats, and ends a stream after its maximum lifetime", async () => {
    await start({ stream: { heartbeatMs: 50, maxStreamMs: 400 } });
    const c = await SseClient.open("/v1/stream");
    await until(() => c.messages.some((m) => m.comment === "ping"), "heartbeat");
    await until(() => c.ended, "stream ended by the server", 3_000);
    await until(() => feed.size === 0, "released");
  });

  it("re-checks its credential while open: a revoked key stops receiving events within the interval", async () => {
    await start({ stream: { heartbeatMs: 50, maxStreamMs: 60_000, recheckMs: 100 } });
    const c = await SseClient.open("/v1/stream");
    expect(c.status).toBe(200);
    await sleep(250); // several re-checks pass while the key is valid
    expect(c.ended).toBe(false);
    await h.db.update(schema.apiKeys).set({ revokedAt: ctx.now() }).where(eq(schema.apiKeys.tenantId, tenant));
    await until(() => c.ended, "stream ended after revocation", 2_000);
    await until(() => feed.size === 0, "released");
    expect((await SseClient.open("/v1/stream")).status).toBe(401);
  });
});
