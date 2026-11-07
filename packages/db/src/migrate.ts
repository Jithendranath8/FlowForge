import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Advisory lock key shared by every FlowForge migrator ("ffmigrat" as a 64-bit integer). */
export const MIGRATION_LOCK = 0x66666d6967726174n;

/**
 * How long a migrator waits for any lock before giving up: the migration lock held by
 * another instance, or a table lock a migration statement needs. Long enough for an
 * ordinary migration by another instance to finish; a waiter that gives up applies
 * nothing and can simply be restarted.
 */
export const DEFAULT_MIGRATION_LOCK_WAIT_MS = 120_000;

/** Structured logging, pino-style (fields first). Never receives URLs or credentials. */
export interface MigrationLog {
  info(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface MigrateOptions {
  /** Upper bound on every lock wait in the migration transaction (default 120 s). */
  lockWaitMs?: number;
  log?: MigrationLog;
}

/** The session holding the migration lock, as far as pg_stat_activity tells. */
export interface MigrationLockHolder {
  pid: number;
  applicationName: string;
  state: string | null;
  /** How long its transaction has been open. */
  transactionMs: number | null;
}

/** Another session held the migration lock for longer than the wait allowed. Nothing was applied. */
export class MigrationLockTimeoutError extends Error {
  readonly code = "migration_lock_timeout";
  constructor(
    readonly waitedMs: number,
    readonly lockWaitMs: number,
    readonly holder: MigrationLockHolder | null,
  ) {
    const by = holder
      ? ` It is held by pid ${holder.pid} (application "${holder.applicationName}", ${holder.state ?? "unknown state"}${holder.transactionMs === null ? "" : `, transaction open ${Math.round(holder.transactionMs / 1000)} s`}).`
      : "";
    super(
      `Gave up after ${Math.round(waitedMs / 1000)} s waiting for the migration lock: another instance (or flowforge-admin) is migrating this database.${by} ` +
        "This instance applied nothing. If that migration is still progressing, let it finish and restart this instance; if it is stuck, end that session (pg_terminate_backend) and restart.",
    );
    this.name = "MigrationLockTimeoutError";
  }
}

/** Applying migrations failed. The whole attempt was rolled back: nothing from it is applied. */
export class MigrationFailedError extends Error {
  readonly code = "migration_failed";
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "MigrationFailedError";
  }
}

const silent: MigrationLog = { info: () => {}, error: () => {} };
const LOCK_TIMEOUT = "55P03"; // lock_not_available: lock_timeout expired
const elapsed = (since: number) => Math.round(performance.now() - since);
const pgError = (err: unknown) => {
  const e = ((err as { cause?: unknown }).cause ?? err) as { code?: unknown; message?: unknown };
  return { code: typeof e.code === "string" ? e.code : undefined, message: typeof e.message === "string" ? e.message : String(err) };
};

/** Migrations recorded so far (0 before Drizzle has created its table). */
async function appliedCount(tx: postgres.TransactionSql): Promise<number> {
  const [t] = await tx<{ exists: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!t!.exists) return 0;
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return r!.n;
}

async function lockHolder(sql: postgres.Sql): Promise<MigrationLockHolder | null> {
  const [h] = await sql<{ pid: number; application_name: string; state: string | null; xact_ms: number | null }[]>`
    select a.pid, a.application_name, a.state, (extract(epoch from now() - a.xact_start) * 1000)::float8 as xact_ms
    from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted
      and ((l.classid::bigint << 32) | l.objid::bigint) = ${MIGRATION_LOCK.toString()}::bigint
    limit 1`;
  return h ? { pid: h.pid, applicationName: h.application_name, state: h.state, transactionMs: h.xact_ms === null ? null : Number(h.xact_ms) } : null;
}

/**
 * Apply pending migrations. Idempotent, and safe when several instances start at once,
 * over a direct connection or through a transaction-mode pooler.
 *
 * Everything runs in ONE transaction holding a transaction-level advisory lock: the lock,
 * Drizzle's bookkeeping (its schema, table and "last applied" read) and the migrations.
 * - A transaction stays on one server connection, even through a transaction-mode pooler,
 *   so the lock is held by the session doing the work. (A session-level lock taken through
 *   such a pooler stayed held by an idle server connection after the unlock ran elsewhere,
 *   and the next instance waited forever.)
 * - The lock ends with the transaction. Commit, rollback, a failed migration or a dropped
 *   connection all release it; there is no unlock to forget.
 * - A second instance waits for the lock, then reads the committed bookkeeping and applies
 *   nothing.
 *
 * Timeouts, all transaction-local (so also correct through a pooler):
 * - lock_timeout = lockWaitMs: waiting for the migration lock, or for a table lock a
 *   migration needs, is bounded. Giving up rolls back; nothing is applied, no lock is kept.
 * - statement_timeout = 0: running a migration (an index build, say) is not cut short by
 *   the API's query deadline, which some deployments set on the database role.
 * - idle_in_transaction_session_timeout: unchanged; the transaction is never idle for long.
 *
 * Every migration must be transactional (no CREATE INDEX CONCURRENTLY), which Drizzle
 * already requires: it applies pending migrations inside one transaction.
 */
export async function migrate(url: string, opts: MigrateOptions = {}): Promise<void> {
  const lockWaitMs = opts.lockWaitMs ?? DEFAULT_MIGRATION_LOCK_WAIT_MS;
  if (!Number.isInteger(lockWaitMs) || lockWaitMs < 1) throw new RangeError("lockWaitMs must be a positive integer");
  const log = opts.log ?? silent;
  // prepare: false, as in the API's pool: named prepared statements break on
  // transaction-mode poolers. The application name lets operators find a migrator.
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "flowforge-migrate" } });
  const started = performance.now();
  let lockAskedAt = 0;
  let before = 0;
  let after = 0;
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('statement_timeout', '0', true)`;
      await tx`select set_config('lock_timeout', ${String(lockWaitMs)}, true)`;

      log.info({ lockWaitMs }, "migration lock: waiting");
      lockAskedAt = performance.now();
      try {
        await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK.toString()}::bigint)`;
      } catch (err) {
        if (pgError(err).code === LOCK_TIMEOUT) throw new MigrationLockTimeoutError(elapsed(lockAskedAt), lockWaitMs, null);
        throw err;
      }
      log.info({ waitedMs: elapsed(lockAskedAt) }, "migration lock: acquired");

      before = await appliedCount(tx);
      log.info({ applied: before }, "migrations: applying");
      const applyingAt = performance.now();
      try {
        // Drizzle's migrator opens its own transaction with client.begin(). Inside ours that
        // is a savepoint, so its work stays in this transaction, under this lock. Its driver
        // also sets type parsers on client.options: the connection's own, as with drizzle(sql).
        const client = Object.assign(tx, { begin: (fn: (t: postgres.TransactionSql) => unknown) => tx.savepoint(fn), options: sql.options });
        await drizzleMigrate(drizzle(client as unknown as postgres.Sql), { migrationsFolder: MIGRATIONS_DIR });
        after = await appliedCount(tx);
      } catch (err) {
        const e = pgError(err);
        const why = e.code === LOCK_TIMEOUT ? ` (a migration waited longer than ${Math.round(lockWaitMs / 1000)} s for a table lock another session holds)` : "";
        log.error({ durationMs: elapsed(applyingAt), code: e.code, error: e.message }, "migrations: failed and rolled back");
        throw new MigrationFailedError(`Applying migrations failed and was rolled back, so nothing from this attempt is applied${why}: ${e.message}`, { cause: err });
      }
    });
    log.info({ newlyApplied: after - before, total: after, durationMs: elapsed(started) }, "migrations: done");
  } catch (err) {
    if (err instanceof MigrationLockTimeoutError) {
      // The transaction is rolled back. Who holds the lock (read-only) makes the error actionable.
      const holder = await lockHolder(sql).catch(() => null);
      const timeout = new MigrationLockTimeoutError(err.waitedMs, lockWaitMs, holder);
      log.error({ waitedMs: err.waitedMs, lockWaitMs, holder }, "migration lock: timed out; nothing applied");
      throw timeout;
    }
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
