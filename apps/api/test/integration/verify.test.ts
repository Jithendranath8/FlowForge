import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DbHandle } from "@flowforge/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatChecks, verifyPostgres, verifyRedis, type Check } from "../../src/verify.js";
import { REDIS_TEST_URL, TEST_URL, setupDatabase } from "./harness.js";

/*
 * `flowforge-admin verify` against the local services. The pooler scenarios (a PgBouncer
 * that rejects or silently drops startup parameters) need a PgBouncer and are recorded
 * in docs/audit/evidence/phase4/verify-pgbouncer-*.log.
 */

let h: DbHandle;
beforeAll(async () => {
  h = await setupDatabase();
});
afterAll(async () => {
  await h?.close();
});

const byName = (checks: Check[]) => Object.fromEntries(checks.map((c) => [`${c.target}:${c.name}`, c]));
const defaults = { statementTimeoutMs: 5_000, idleInTransactionTimeoutMs: 15_000, poolMax: 10 };

describe("verifyPostgres", () => {
  it("passes against a correctly configured database, and enforces the statement timeout", { timeout: 30_000 }, async () => {
    const checks = byName(await verifyPostgres(TEST_URL, { ...defaults, statementTimeoutMs: 1_000 }));
    expect(Object.values(checks).filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(checks["postgres:statement_timeout"]).toMatchObject({ status: "pass", detail: "1000 ms (source: client)" });
    expect(checks["postgres:statement timeout enforced"]!.detail).toMatch(/^57014 after/);
    expect(checks["postgres:transaction integrity"]!.detail).toMatch(/^8\/8/);
    expect(checks["postgres:migrations"]!.status).toBe("pass");
  });

  it("warns when no server-side timeout is in effect", { timeout: 30_000 }, async () => {
    const checks = byName(await verifyPostgres(TEST_URL, { ...defaults, statementTimeoutMs: 0 }));
    expect(checks["postgres:statement_timeout"]).toMatchObject({ status: "warn" });
    expect(checks["postgres:statement timeout enforced"]).toBeUndefined();
  });

  it("classifies TLS from the connection string: unverified is a warning, none is a failure", async () => {
    // .invalid never resolves (RFC 2606), so connecting fails fast without leaving the host.
    const tls = async (query: string) => byName(await verifyPostgres(`postgres://u:p@db.example.invalid:5432/x${query}`, defaults))["postgres:tls"]!;
    expect(await tls("")).toMatchObject({ status: "fail" });
    expect(await tls("?sslmode=require")).toMatchObject({ status: "warn", detail: expect.stringMatching(/verify-full/) });
    expect(await tls("?sslmode=verify-full")).toMatchObject({ status: "pass" });
    expect(await tls("?sslrootcert=system")).toMatchObject({ status: "pass" });
    const checks = byName(await verifyPostgres("postgres://u:p@db.example.invalid:5432/x?sslmode=verify-full", defaults));
    expect(checks["postgres:connect"]!.status).toBe("fail");
  });

  it("rejects a malformed connection string", async () => {
    expect(await verifyPostgres("not a url", defaults)).toEqual([{ target: "postgres", name: "connection string", status: "fail", detail: "DATABASE_URL is not a valid URL" }]);
  });
});

describe("verifyRedis", () => {
  it("passes against a reachable Redis, including the notifier's PSUBSCRIBE + pipelined PUBLISH", async () => {
    const checks = byName(await verifyRedis(REDIS_TEST_URL, { commandTimeoutMs: 1_000 }));
    expect(Object.values(checks).filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(checks["redis:pub/sub"]!.detail).toMatch(/^PSUBSCRIBE \+ pipelined PUBLISH delivered in/);
  });

  it("requires rediss:// for a remote host", async () => {
    const plain = byName(await verifyRedis("redis://cache.example.invalid:6379", { commandTimeoutMs: 500 }));
    expect(plain["redis:tls"]!.status).toBe("fail");
    expect(plain["redis:checks"]!.status).toBe("fail");
    const tls = byName(await verifyRedis("rediss://cache.example.invalid:6379", { commandTimeoutMs: 500 }));
    expect(tls["redis:tls"]!.status).toBe("pass");
  });
});

describe("flowforge-admin verify", () => {
  const ADMIN = fileURLToPath(new URL("../../dist/admin.js", import.meta.url));
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [ADMIN, "verify", ...args], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_URL, ...env }, encoding: "utf8", timeout: 60_000 });

  it("exits 0 with a readable report when everything passes, without migrating anything", () => {
    const r = run({ REDIS_URL: REDIS_TEST_URL, DATABASE_STATEMENT_TIMEOUT_MS: "1000" }, "--instances", "2");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS {2}postgres statement timeout enforced +57014/m);
    expect(r.stdout).toMatch(/^PASS {2}redis {4}pub\/sub/m);
    expect(r.stdout).toMatch(/× 2 instance\(s\)/);
  });

  it("emits JSON and exits 1 when a check fails", () => {
    const r = run({ DATABASE_URL: "postgres://u:p@db.example.invalid:5432/x" }, "--json");
    expect(r.status).toBe(1);
    const checks = JSON.parse(r.stdout) as Check[];
    expect(checks.filter((c) => c.status === "fail").map((c) => c.name)).toEqual(["tls", "connect"]);
    expect(formatChecks(checks)).toMatch(/^FAIL {2}postgres tls/m);
  });
});
