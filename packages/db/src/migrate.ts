import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Advisory lock key shared by every FlowForge migrator ("ffmigrat" as a 64-bit integer). */
const MIGRATION_LOCK = 0x66666d6967726174n;

/**
 * Apply pending migrations with a dedicated single connection. Idempotent.
 *
 * Several API instances may start at once: each takes a session advisory lock on its
 * connection first, so they migrate one after another (the later ones find nothing
 * pending). The lock goes with the connection if a migrator dies. It needs a real
 * session, so behind a transaction-mode pooler point DATABASE_URL at a direct connection
 * for upgrades, or start one instance first.
 */
export async function migrate(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK.toString()}::bigint)`;
    try {
      await drizzleMigrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK.toString()}::bigint)`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
