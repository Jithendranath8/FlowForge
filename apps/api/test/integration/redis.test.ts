import { type DbHandle } from "@flowforge/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relayOutbox } from "../../src/engine/maintenance.js";
import { submitRun } from "../../src/engine/runs.js";
import { registerWorkflow } from "../../src/engine/workflows.js";
import { FALLBACK_POLL_MS, RedisNotifier } from "../../src/infra/notifier.js";
import { REDIS_TEST_URL, TestClock, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

const log = pino({ level: "silent" });
let h: DbHandle;

beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});

async function ready(n: RedisNotifier) {
  for (let i = 0; i < 50 && !n.healthy(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(n.healthy()).toBe(true);
}

describe("Redis wake-ups", () => {
  it("wakes a waiting worker as soon as the outbox relays task.queued", async () => {
    await resetData(h);
    const notifier = new RedisNotifier(REDIS_TEST_URL, log);
    try {
      await ready(notifier);
      const ctx = makeContext(h, new TestClock(), notifier);
      const tenant = await createTenant(h, "acme");
      await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });

      const started = Date.now();
      const waiting = notifier.waitForWork(tenant, ["default"], 10_000);
      await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
      expect(await relayOutbox(ctx)).toBeGreaterThan(0);
      await waiting;
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await notifier.close();
    }
  });

  it("streams tenant events to dashboard listeners", async () => {
    await resetData(h);
    const notifier = new RedisNotifier(REDIS_TEST_URL, log);
    try {
      await ready(notifier);
      const ctx = makeContext(h, new TestClock(), notifier);
      const tenant = await createTenant(h, "acme");
      const seen: string[] = [];
      const off = notifier.onTenantEvent(tenant, (e) => seen.push((e as { type: string }).type));
      await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
      await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
      await relayOutbox(ctx);
      for (let i = 0; i < 40 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
      off();
      expect(seen).toEqual(["run.created", "task.queued"]);
    } finally {
      await notifier.close();
    }
  });
});

describe("Redis unavailable", () => {
  it("keeps outbox rows and degrades waits to the fallback poll interval", async () => {
    await resetData(h);
    // Nothing listens on this port: simulates Redis being down.
    const notifier = new RedisNotifier("redis://127.0.0.1:1", log);
    try {
      const ctx = makeContext(h, new TestClock(), notifier);
      const tenant = await createTenant(h, "acme");
      await registerWorkflow(ctx, tenant, { name: "one", tasks: [{ key: "a", type: "job" }] });
      await submitRun(ctx, tenant, { workflow: "one", triggeredBy: "t" });
      expect(notifier.healthy()).toBe(false);
      expect(await relayOutbox(ctx)).toBe(0); // nothing lost, nothing marked published

      const started = Date.now();
      await notifier.waitForWork(tenant, ["default"], 20_000);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(FALLBACK_POLL_MS - 50);
      expect(waited).toBeLessThan(FALLBACK_POLL_MS + 500);

      const pending = await h.sql`select count(*)::int as n from outbox where published_at is null`;
      expect(pending[0]!.n).toBeGreaterThan(0);
    } finally {
      await notifier.close();
    }
  });
});
