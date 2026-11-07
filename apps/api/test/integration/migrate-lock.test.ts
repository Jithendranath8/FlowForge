import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { MIGRATIONS_DIR, MIGRATION_LOCK, MigrationFailedError, MigrationLockTimeoutError, connect, migrate, type MigrationLog } from "@flowforge/db";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_URL } from "./harness.js";

/*
 * Migrations under concurrent starts, failures, crashes, and transaction-mode poolers.
 *
 * migrate() runs the lock, Drizzle's bookkeeping and the migrations in one transaction
 * holding a transaction-level advisory lock (packages/db/src/migrate.ts). Before that it
 * took a session-level lock: through a transaction-mode pooler the unlock ran on another
 * server connection, the lock stayed held by an idle one, and the next instance waited
 * forever. The pooler tests below reproduce that with a real PgBouncer.
 */

const DB = "flowforge_migrate_lock_test";
const urlFor = (db: string) => ADMIN_URL.replace(/\/[^/]+$/, `/${db}`);
const DIRECT = urlFor(DB);
const MIGRATION_COUNT = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length;
const KEY = MIGRATION_LOCK.toString();
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

async function freshDatabase() {
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
}
async function onDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DIRECT, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
/** Migration advisory locks in this database, granted or waiting. */
const migrationLocks = () =>
  onDb(
    (sql) => sql<{ granted: boolean }[]>`
      select l.granted from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and a.datname = ${DB}
        and ((l.classid::bigint << 32) | l.objid::bigint) = ${KEY}::bigint`,
  );
const appliedMigrations = () => onDb(async (sql) => (await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n);
const settle = <T>(p: Promise<T>) => p.then(() => "ok", (e: unknown) => String((e as Error).cause ?? e));
/** Captures migrate()'s structured log lines. */
function recorder() {
  const lines: { level: "info" | "error"; msg: string; fields: Record<string, unknown> }[] = [];
  const log: MigrationLog = {
    info: (fields, msg) => lines.push({ level: "info", msg, fields }),
    error: (fields, msg) => lines.push({ level: "error", msg, fields }),
  };
  return { lines, log, messages: () => lines.map((l) => l.msg) };
}
/** Holds the migration lock in an open transaction on its own connection until released. */
async function holdLock(url = DIRECT) {
  const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { application_name: "lock-holder-test" } });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${KEY}::bigint)`;
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await done;
      await sql.end({ timeout: 5 });
    },
  };
}
const pending = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "settled"), new Promise<string>((r) => setTimeout(() => r("waiting"), ms))]);

afterAll(async () => {
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.end({ timeout: 5 });
});

describe("migrations over a direct connection", () => {
  beforeEach(freshDatabase);

  it("lets every instance that starts at once finish, applying each migration exactly once", async () => {
    const results = await Promise.all([migrate(DIRECT), migrate(DIRECT), migrate(DIRECT), migrate(DIRECT)].map(settle));
    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
    expect(await migrationLocks()).toEqual([]);
  });

  it("makes a second migrator wait while the lock is held, then apply nothing more", async () => {
    await migrate(DIRECT);
    const holder = postgres(DIRECT, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const held = holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${KEY}::bigint)`;
      await released;
    });
    try {
      await expect.poll(async () => (await migrationLocks()).filter((l) => l.granted).length).toBe(1);
      const second = migrate(DIRECT);
      expect(await pending(second, 500)).toBe("waiting");
      expect((await migrationLocks()).map((l) => l.granted).sort()).toEqual([false, true]);
      release();
      await held;
      await second;
      expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
      expect(await migrationLocks()).toEqual([]);
    } finally {
      release();
      await holder.end({ timeout: 5 });
    }
  });

  it("rolls a failed migration back completely, releases the lock, and succeeds on retry", async () => {
    // 0000_init creates attempt_outcome, then member_role: make the second statement fail.
    await onDb((sql) => sql`create type public.member_role as enum ('conflict')`);
    const rec = recorder();
    const err = await migrate(DIRECT, { log: rec.log }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationFailedError); // a failure to apply, not a lock timeout
    expect((err as MigrationFailedError).message).toMatch(/rolled back.*member_role.*already exists/);
    expect(rec.messages()).toEqual(["migration lock: waiting", "migration lock: acquired", "migrations: applying", "migrations: failed and rolled back"]);
    expect(await migrationLocks()).toEqual([]);
    const leftovers = await onDb(
      (sql) => sql<{ n: number }[]>`select (select count(*) from pg_type where typname = 'attempt_outcome') + (select count(*) from pg_namespace where nspname = 'drizzle') as n`,
    );
    expect(Number(leftovers[0]!.n)).toBe(0); // nothing half-applied, not even Drizzle's own table

    await onDb((sql) => sql`drop type public.member_role`);
    await migrate(DIRECT);
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
  });

  it("frees the lock when the process holding it is killed", async () => {
    // A separate process takes the lock in an open transaction, as a migrating instance
    // would, and is then SIGKILLed: its connection drops and Postgres ends the transaction.
    const child: ChildProcess = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import postgres from "postgres";
         const sql = postgres(process.env.URL, { max: 1, onnotice: () => {} });
         await sql.begin(async (tx) => {
           await tx\`select pg_advisory_xact_lock(\${process.env.KEY}::bigint)\`;
           process.stdout.write("locked\\n");
           await new Promise(() => {});
         });`,
      ],
      { env: { PATH: process.env.PATH ?? "", URL: DIRECT, KEY }, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
        child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
      });
      const waiting = migrate(DIRECT);
      expect(await pending(waiting, 500)).toBe("waiting");
      child.kill("SIGKILL");
      await waiting;
      expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
      expect(await migrationLocks()).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("bounded lock waits and startup diagnostics", () => {
  beforeEach(freshDatabase);

  it("logs each stage of a normal migration, with timings and nothing secret", async () => {
    const rec = recorder();
    await migrate(DIRECT, { log: rec.log });
    expect(rec.messages()).toEqual(["migration lock: waiting", "migration lock: acquired", "migrations: applying", "migrations: done"]);
    const [waiting, acquired, applying, done] = rec.lines;
    expect(waiting!.fields).toEqual({ lockWaitMs: 120_000 });
    expect(acquired!.fields.waitedMs).toEqual(expect.any(Number));
    expect(applying!.fields).toEqual({ applied: 0 });
    expect(done!.fields).toMatchObject({ newlyApplied: MIGRATION_COUNT, total: MIGRATION_COUNT, durationMs: expect.any(Number) });
    const text = JSON.stringify(rec.lines);
    const admin = new URL(ADMIN_URL);
    expect(text).not.toContain(decodeURIComponent(admin.password));
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("gives up within the configured wait while another session holds the lock, applying nothing and keeping no lock", async () => {
    const holder = await holdLock();
    try {
      const rec = recorder();
      const t0 = performance.now();
      const err = await migrate(DIRECT, { lockWaitMs: 300, log: rec.log }).catch((e: unknown) => e);
      const took = performance.now() - t0;
      expect(err).toBeInstanceOf(MigrationLockTimeoutError);
      const e = err as MigrationLockTimeoutError;
      expect(e.code).toBe("migration_lock_timeout");
      expect(e.waitedMs).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(3_000);
      expect(e.holder).toMatchObject({ applicationName: "lock-holder-test", pid: expect.any(Number) });
      expect(e.message).toMatch(/Gave up after 0 s waiting for the migration lock.*pid \d+.*lock-holder-test.*applied nothing/);
      expect(rec.messages()).toEqual(["migration lock: waiting", "migration lock: timed out; nothing applied"]);
      expect(rec.lines[1]!.fields).toMatchObject({ lockWaitMs: 300, holder: { applicationName: "lock-holder-test" } });
      // No migration ran without the lock: not even Drizzle's own schema exists.
      const drizzle = await onDb((sql) => sql`select 1 from pg_namespace where nspname = 'drizzle'`);
      expect(drizzle).toHaveLength(0);
      // Only the holder's lock remains: the waiter left nothing granted or queued.
      expect(await migrationLocks()).toEqual([{ granted: true }]);
    } finally {
      await holder.release();
    }
    expect(await migrationLocks()).toEqual([]);
    await migrate(DIRECT, { lockWaitMs: 300 }); // the lock is free again: the retry succeeds
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
  });

  it("after timing out, succeeds once the holding process has exited", async () => {
    const child: ChildProcess = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import postgres from "postgres";
         const sql = postgres(process.env.URL, { max: 1, onnotice: () => {} });
         await sql.begin(async (tx) => {
           await tx\`select pg_advisory_xact_lock(\${process.env.KEY}::bigint)\`;
           process.stdout.write("locked\\n");
           await new Promise(() => {});
         });`,
      ],
      { env: { PATH: process.env.PATH ?? "", URL: DIRECT, KEY }, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
        child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
      });
      await expect(migrate(DIRECT, { lockWaitMs: 300 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      child.kill("SIGKILL");
      await expect.poll(migrationLocks, { timeout: 5_000 }).toEqual([]);
      await migrate(DIRECT, { lockWaitMs: 300 });
      expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("bounds a migration's wait for a table lock too, and reports it as a migration failure", async () => {
    await migrate(DIRECT);
    // Make the last migration (CREATE INDEX tasks_aging_idx ON tasks) pending again.
    await onDb(async (sql) => {
      await sql`drop index tasks_aging_idx`;
      await sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`;
    });
    // An application transaction holds the tasks table.
    const app = postgres(DIRECT, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const held = app.begin(async (tx) => {
      await tx`lock table tasks in access exclusive mode`;
      locked();
      await released;
    });
    await isLocked;
    try {
      const err = await migrate(DIRECT, { lockWaitMs: 300 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrationFailedError);
      expect((err as Error).message).toMatch(/waited longer than 0 s for a table lock/);
      expect(await migrationLocks()).toEqual([]);
    } finally {
      release();
      await held;
      await app.end({ timeout: 5 });
    }
    await migrate(DIRECT, { lockWaitMs: 300 });
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
    expect(await onDb((sql) => sql`select 1 from pg_indexes where indexname = 'tasks_aging_idx'`)).toHaveLength(1);
  });

  it("rejects a nonsensical wait", async () => {
    await expect(migrate(DIRECT, { lockWaitMs: 0 })).rejects.toThrow(RangeError);
  });
});

/*
 * Through PgBouncer in transaction mode, with round-robin server selection so consecutive
 * transactions land on different server connections (as on a busy hosted pooler). Needs
 * Docker; skipped, and reported, when Docker is not available.
 */
const PGBOUNCER = "edoburu/pgbouncer:v1.26.0-p0@sha256:b17551c776ef7e5769ef80b956d20f85e2fd25dd8912d31d58f782aad495b711";
const dockerAvailable = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
if (!dockerAvailable) console.warn("migrate-lock.test: Docker not available, so the transaction-mode pooler tests are SKIPPED (not passed).");

describe.skipIf(!dockerAvailable)("migrations through a transaction-mode pooler (PgBouncer)", () => {
  const name = `ff-migrate-lock-pgbouncer-${process.pid}`;
  let pooled = "";

  beforeAll(async () => {
    const upstream = new URL(ADMIN_URL);
    upstream.hostname = "host.docker.internal";
    upstream.pathname = `/${DB}`;
    spawnSync("docker", ["rm", "-f", name]);
    const run = spawnSync(
      "docker",
      [
        "run", "-d", "--name", name, "--add-host", "host.docker.internal:host-gateway",
        "-e", `DATABASE_URL=${upstream.toString()}`,
        "-e", "POOL_MODE=transaction", "-e", "SERVER_ROUND_ROBIN=1", "-e", "DEFAULT_POOL_SIZE=4",
        "-e", "AUTH_TYPE=scram-sha-256", "-e", "MAX_CLIENT_CONN=100", "-e", "LISTEN_PORT=5432",
        "-p", "127.0.0.1::5432", PGBOUNCER,
      ],
      { encoding: "utf8" },
    );
    if (run.status !== 0) throw new Error(`could not start PgBouncer: ${run.stderr}`);
    const port = spawnSync("docker", ["port", name, "5432"], { encoding: "utf8" }).stdout.trim().split(":").pop();
    const u = new URL(ADMIN_URL);
    u.port = port!;
    u.pathname = `/${DB}`;
    pooled = u.toString();
  }, 120_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", name]);
  });

  beforeEach(async () => {
    await freshDatabase();
    // Wait for the pooler, then open several server connections so round-robin spreads
    // the migrator's transactions across them.
    const warm = postgres(pooled, { max: 4, prepare: false, onnotice: () => {} });
    try {
      await expect.poll(() => warm`select 1`.then(() => true, () => false), { timeout: 30_000, interval: 250 }).toBe(true);
      await Promise.all([1, 2, 3, 4].map(() => warm.begin((tx) => tx`select pg_sleep(0.2)`)));
    } finally {
      await warm.end({ timeout: 5 });
    }
  }, 60_000);

  it("leaves no lock held after migrating, so the next instance does not hang", async () => {
    await migrate(pooled);
    expect(await migrationLocks()).toEqual([]); // the session-level lock stayed granted to an idle server connection
    const next = migrate(pooled);
    expect(await pending(next, 5_000)).toBe("settled"); // it used to wait forever here
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
  });

  it("lets instances that start at once finish, applying each migration exactly once", async () => {
    const results = await Promise.all([migrate(pooled), migrate(pooled), migrate(pooled), migrate(pooled)].map(settle));
    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
    expect(await migrationLocks()).toEqual([]);
  });

  it("keeps the application's pooled connections working afterwards", async () => {
    await migrate(pooled);
    // The API's own pool, configured for a transaction-mode pooler (no startup parameters).
    const h = connect(pooled, { max: 4, applicationName: "flowforge-test", statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 });
    try {
      const counts = await Promise.all([1, 2, 3, 4, 5, 6].map(() => h.sql<{ n: number }[]>`select count(*)::int as n from tenants`));
      expect(counts.every((r) => r[0]!.n === 0)).toBe(true);
      const inTx = await h.sql.begin(async (tx) => {
        const [a] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const [b] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        return a!.pid === b!.pid;
      });
      expect(inTx).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("times out through the pooler without keeping a lock, and the next attempt succeeds", async () => {
    const holder = await holdLock(DIRECT);
    try {
      await expect(migrate(pooled, { lockWaitMs: 300 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
      expect(await migrationLocks()).toEqual([{ granted: true }]); // only the holder: nothing stuck on a pooled server connection
    } finally {
      await holder.release();
    }
    expect(await migrationLocks()).toEqual([]);
    expect(await pending(migrate(pooled, { lockWaitMs: 300 }), 5_000)).toBe("settled");
    expect(await appliedMigrations()).toBe(MIGRATION_COUNT);
  });
});
