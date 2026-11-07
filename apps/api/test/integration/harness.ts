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

/** Timestamp columns filled by fixtures and operators (database clock), not by the engine. */
const OUT_OF_BAND_COLUMNS = new Set([
  "tenants.created_at",
  "users.created_at",
  "oauth_accounts.created_at",
  "memberships.created_at",
  "sessions.created_at",
  "sessions.expires_at",
  "sessions.last_seen_at",
  "api_keys.created_at",
  "api_keys.expires_at",
  "api_keys.revoked_at",
]);

/**
 * ADR-015 invariant: every timestamp the engine writes comes from ctx.now(). Returns the
 * engine-written timestamptz columns holding values outside [from, to], which must be
 * the range of the engine clock the test used. Every timestamptz column in the schema
 * is checked, so a column added later is covered automatically.
 */
export async function timestampsOutside(h: DbHandle, from: Date, to: Date): Promise<string[]> {
  const cols = await h.sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and data_type = 'timestamp with time zone' order by 1, 2`;
  const bad: string[] = [];
  for (const { table_name: t, column_name: c } of cols) {
    if (OUT_OF_BAND_COLUMNS.has(`${t}.${c}`)) continue;
    const [r] = await h.sql.unsafe<{ n: number; lo: string | null; hi: string | null }[]>(
      `select count(*)::int as n, min("${c}")::text as lo, max("${c}")::text as hi from "${t}"
       where "${c}" < $1::timestamptz or "${c}" > $2::timestamptz`,
      [from.toISOString(), to.toISOString()],
    );
    if (r!.n > 0) bad.push(`${t}.${c}: ${r!.n} row(s) in [${r!.lo}, ${r!.hi}]`);
  }
  return bad;
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
