import { readdirSync } from "node:fs";
import { MIGRATIONS_DIR, migrate } from "@flowforge/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL } from "./harness.js";

/*
 * Several API instances may start at once against a database that needs migrating.
 * They must take turns: without a lock they race on the same CREATE statements.
 */

const DB = "flowforge_migrate_lock_test";
const URL_ = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

beforeAll(async () => {
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.unsafe(`create database ${DB}`);
});
afterAll(async () => {
  await admin.unsafe(`drop database if exists ${DB} with (force)`);
  await admin.end({ timeout: 5 });
});

describe("migrations under concurrent starts", () => {
  it("lets every instance finish, applying each migration exactly once", async () => {
    const results = await Promise.allSettled([migrate(URL_), migrate(URL_), migrate(URL_), migrate(URL_)]);
    expect(results.map((r) => (r.status === "rejected" ? String((r.reason as Error).cause ?? r.reason) : "ok"))).toEqual(["ok", "ok", "ok", "ok"]);
    const db = postgres(URL_, { max: 1, onnotice: () => {} });
    try {
      const [row] = await db<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(row!.n).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).length);
    } finally {
      await db.end({ timeout: 5 });
    }
  });
});
