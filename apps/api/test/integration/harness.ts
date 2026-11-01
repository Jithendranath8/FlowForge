import { connect, migrate, schema, type DbHandle } from "@flowforge/db";
import pino from "pino";
import postgres from "postgres";
import { generateApiKey, type Scope } from "../../src/auth/tokens.js";
import type { EngineContext } from "../../src/engine/context.js";
import { NullNotifier, type Notifier } from "../../src/infra/notifier.js";

export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://flowforge:flowforge_dev_only@127.0.0.1:54329/flowforge";
export const TEST_DB = "flowforge_test";
export const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);
export const REDIS_TEST_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:63799/15";

/** Recreate the test database and apply migrations. Call from beforeAll. */
export async function setupDatabase(): Promise<DbHandle> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();
  await migrate(TEST_URL);
  return connect(TEST_URL, { max: 20, applicationName: "flowforge-test" });
}

export async function resetData(h: DbHandle): Promise<void> {
  await h.sql.unsafe(
    "truncate tenants, users, workers, events, outbox, scheduling_decisions, task_type_stats restart identity cascade",
  );
}

export class TestClock {
  t = new Date("2026-01-01T00:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function makeContext(h: DbHandle, clock: TestClock, notifier: Notifier = new NullNotifier()): EngineContext {
  return {
    db: h.db,
    now: clock.now,
    notifier,
    log: pino({ level: "silent" }),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
    workerOfflineAfterMs: 60_000,
  };
}

export async function createTenant(h: DbHandle, slug: string, maxConcurrency = 256): Promise<string> {
  const [t] = await h.db.insert(schema.tenants).values({ slug, name: slug, maxConcurrency }).returning();
  return t!.id;
}

export async function createApiKey(h: DbHandle, tenantId: string, scopes: Scope[], opts: { revoked?: boolean; expired?: boolean } = {}): Promise<string> {
  const k = generateApiKey();
  await h.db.insert(schema.apiKeys).values({
    tenantId,
    name: "test",
    prefix: k.prefix,
    hash: k.hash,
    scopes,
    revokedAt: opts.revoked ? new Date() : null,
    expiresAt: opts.expired ? new Date(Date.now() - 1000) : null,
  });
  return k.key;
}
