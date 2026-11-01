import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export { migrate } from "./migrate.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Max pool size. Free-tier Postgres providers limit connections; keep this small. */
  max?: number;
  applicationName?: string;
}

export function connect(url: string, opts: ConnectOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // compatible with transaction-mode poolers (e.g. Neon pooled endpoints)
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? "flowforge" },
  });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end({ timeout: 5 }) };
}
