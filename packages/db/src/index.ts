import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Semaphore, guardClient, type DbTimeouts } from "./guard.js";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export {
  DEFAULT_MIGRATION_LOCK_WAIT_MS,
  MIGRATIONS_DIR,
  MIGRATION_LOCK,
  MigrationFailedError,
  MigrationLockTimeoutError,
  migrate,
  type MigrateOptions,
  type MigrationLockHolder,
  type MigrationLog,
} from "./migrate.js";
export { redactDbError } from "./redact.js";
export { DbTimeoutError, Semaphore, classifyDbError, guardClient, type DbTimeoutKind, type DbTimeouts } from "./guard.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  /** Drizzle client. Every query and transaction issued through it is time-bounded. */
  db: Database;
  /** Raw postgres.js client, NOT time-bounded. For tests and operator tooling only. */
  sql: postgres.Sql;
  /** Current pool usage as seen by the acquisition semaphore. */
  stats: () => { size: number; inUse: number; queued: number };
  close: () => Promise<void>;
}

export interface ConnectOptions extends Partial<DbTimeouts> {
  /** Max pool size. Free-tier Postgres providers limit connections; keep this small. */
  max?: number;
  applicationName?: string;
  /** Server-side `statement_timeout`; 0 disables (e.g. a pooler that rejects startup parameters). */
  statementTimeoutMs?: number;
  /** Server-side `idle_in_transaction_session_timeout`; 0 disables. */
  idleInTransactionTimeoutMs?: number;
}

export const DEFAULT_DB_TIMEOUTS = {
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 15_000,
  acquireTimeoutMs: 2_000,
  queryTimeoutMs: 8_000,
  transactionTimeoutMs: 10_000,
} as const;

export function connect(url: string, opts: ConnectOptions = {}): DbHandle {
  const max = opts.max ?? 10;
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_DB_TIMEOUTS.statementTimeoutMs;
  const idleInTxMs = opts.idleInTransactionTimeoutMs ?? DEFAULT_DB_TIMEOUTS.idleInTransactionTimeoutMs;
  const sql = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // compatible with transaction-mode poolers (e.g. Neon pooled endpoints)
    onnotice: () => {},
    // Sent as startup parameters, so every pooled connection carries them.
    connection: {
      application_name: opts.applicationName ?? "flowforge",
      ...(statementTimeoutMs > 0 ? { statement_timeout: statementTimeoutMs } : {}),
      ...(idleInTxMs > 0 ? { idle_in_transaction_session_timeout: idleInTxMs } : {}),
    },
  });
  const permits = new Semaphore(max);
  const guarded = guardClient(sql, permits, {
    acquireTimeoutMs: opts.acquireTimeoutMs ?? DEFAULT_DB_TIMEOUTS.acquireTimeoutMs,
    queryTimeoutMs: opts.queryTimeoutMs ?? DEFAULT_DB_TIMEOUTS.queryTimeoutMs,
    transactionTimeoutMs: opts.transactionTimeoutMs ?? DEFAULT_DB_TIMEOUTS.transactionTimeoutMs,
  });
  return {
    db: drizzle(guarded, { schema }),
    sql,
    stats: () => ({ size: permits.size, inUse: permits.inUse, queued: permits.queued }),
    close: () => sql.end({ timeout: 5 }),
  };
}
