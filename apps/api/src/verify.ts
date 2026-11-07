import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR, connect, type DbHandle } from "@flowforge/db";
import { Redis } from "ioredis";
import { DatabaseClock, postgresTimeSource } from "./infra/clock.js";

/*
 * Deployment verification (`flowforge-admin verify`). Connects to the configured
 * Postgres and Redis exactly as the API does and checks what breaks on hosted
 * providers: TLS and certificate verification, connection poolers that drop or reject
 * startup parameters, server-side statement timeouts, transaction integrity through a
 * pooler, clock offset, latency, connection headroom, migrations, and Redis pub/sub.
 * Read-only: it creates no tables and changes no data.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export interface Check {
  target: "postgres" | "redis";
  name: string;
  status: CheckStatus;
  detail: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocal = (host: string) => LOCAL_HOSTS.has(host) || host.endsWith(".local") || host === "host.docker.internal";

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
const ms = (n: number) => `${n.toFixed(n < 10 ? 2 : 0)} ms`;
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errCode = (err: unknown) => String((err as { code?: unknown }).code ?? "");

export interface PostgresVerifyOptions {
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  poolMax: number;
  /** Expected API instances sharing the database (for connection headroom). */
  instances?: number;
}

export async function verifyPostgres(url: string, opts: PostgresVerifyOptions): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => out.push({ target: "postgres", name, status, detail });

  // ---------------------------------------------------------------- TLS (from the URL: what the client enforces)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    add("connection string", "fail", "DATABASE_URL is not a valid URL");
    return out;
  }
  const host = parsed.hostname;
  const sslmode = parsed.searchParams.get("sslmode") ?? parsed.searchParams.get("ssl");
  const verified = sslmode === "verify-full" || parsed.searchParams.get("sslrootcert") === "system";
  if (isLocal(host)) add("tls", "info", `local host ${host}; TLS not required`);
  else if (verified) add("tls", "pass", `TLS with certificate and hostname verification (${sslmode ?? "sslrootcert=system"})`);
  else if (sslmode === "require" || sslmode === "verify-ca")
    add("tls", "warn", `sslmode=${sslmode} encrypts but does not verify the server's hostname; use sslmode=verify-full (hosted providers use publicly trusted certificates)`);
  else add("tls", "fail", `no TLS required for remote host ${host}${sslmode ? ` (sslmode=${sslmode})` : ""}; add sslmode=verify-full`);

  // ---------------------------------------------------------------- connect exactly as the API does
  let h: DbHandle;
  try {
    h = connect(url, { max: Math.min(5, opts.poolMax), applicationName: "flowforge-verify", statementTimeoutMs: opts.statementTimeoutMs, idleInTransactionTimeoutMs: opts.idleInTransactionTimeoutMs });
    await h.sql`select 1`;
  } catch (err) {
    const m = errMsg(err);
    if (/unsupported startup parameter/i.test(m)) {
      add(
        "connect",
        "fail",
        `${m}. The pooler rejects the API's startup parameters: set DATABASE_STATEMENT_TIMEOUT_MS=0 and DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS=0, then set both on the database role (ALTER ROLE ... SET statement_timeout = '5s'; ALTER ROLE ... SET idle_in_transaction_session_timeout = '15s')`,
      );
    } else add("connect", "fail", m);
    return out;
  }

  try {
    const [v] = await h.sql<{ version: string; num: number; ssl: boolean | null; ssl_version: string | null }[]>`
      select version() as version, current_setting('server_version_num')::int as num,
             (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl,
             (select version from pg_stat_ssl where pid = pg_backend_pid()) as ssl_version`;
    add("connect", "pass", v!.version.split(",")[0]!);
    add("server version", v!.num >= 130000 ? "pass" : "fail", v!.num >= 130000 ? `server_version_num ${v!.num}` : `server_version_num ${v!.num}; PostgreSQL 13 or later is required`);
    add("server-side tls", "info", v!.ssl ? `this backend's connection uses ${v!.ssl_version} (behind a pooler this is the pooler's connection)` : "this backend's connection is not TLS");

    // ------------------------------------------------------------ startup parameters: applied, and from where
    const settings = await h.sql<{ name: string; setting: string; source: string }[]>`
      select name, setting, source from pg_settings where name in ('statement_timeout', 'idle_in_transaction_session_timeout', 'application_name')`;
    const s = Object.fromEntries(settings.map((r) => [r.name, r]));
    const timeoutCheck = (name: string, expected: number) => {
      const actual = Number(s[name]?.setting ?? 0);
      const source = s[name]?.source ?? "?";
      if (expected > 0 && actual === expected) add(name, "pass", `${actual} ms (source: ${source})`);
      else if (expected > 0) add(name, "fail", `expected ${expected} ms from startup parameters, server has ${actual} ms (source: ${source}): a pooler dropped the parameter; set it on the database role`);
      else if (actual > 0) add(name, "pass", `${actual} ms from ${source} (startup parameter disabled)`);
      else add(name, "warn", "no server-side limit; only the client-side deadlines protect the server");
      return actual;
    };
    const statementTimeout = timeoutCheck("statement_timeout", opts.statementTimeoutMs);
    timeoutCheck("idle_in_transaction_session_timeout", opts.idleInTransactionTimeoutMs);
    add("application_name", s.application_name?.setting === "flowforge-verify" ? "pass" : "warn", `server sees "${s.application_name?.setting ?? ""}"`);

    // ------------------------------------------------------------ the statement timeout is enforced
    if (statementTimeout > 0 && statementTimeout <= 30_000) {
      const t0 = performance.now();
      try {
        await h.sql`select pg_sleep(${(statementTimeout + 2_000) / 1000})`;
        add("statement timeout enforced", "fail", "a statement outlived statement_timeout");
      } catch (err) {
        const took = performance.now() - t0;
        add("statement timeout enforced", errCode(err) === "57014" ? "pass" : "fail", `${errCode(err) || errMsg(err)} after ${ms(took)}`);
      }
    }

    // ------------------------------------------------------------ transactions stay on one server connection
    const pids = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.sql.begin(async (tx) => {
          const [a] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await tx`select pg_sleep(0.05)`;
          const [b] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          return a!.pid === b!.pid;
        }),
      ),
    );
    add("transaction integrity", pids.every(Boolean) ? "pass" : "fail", `${pids.filter(Boolean).length}/8 concurrent transactions kept one server connection throughout`);

    // ------------------------------------------------------------ clock and latency
    const clock = await DatabaseClock.start(postgresTimeSource(h.db), { syncIntervalMs: 3_600_000, samples: 5 });
    const c = clock.stats();
    clock.stop();
    add("clock", Math.abs(c.offsetMs) > 1_000 ? "warn" : "pass", `database clock - this host = ${ms(c.offsetMs)} (±${ms(c.uncertaintyMs)}); engine time follows the database (ADR-015)`);
    const rtts: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await h.sql`select 1`;
      rtts.push(performance.now() - t0);
    }
    const p95 = percentile(rtts, 95);
    add("round trip", p95 > 100 ? "warn" : "pass", `p50 ${ms(percentile(rtts, 50))}, p95 ${ms(p95)} over 20 queries${p95 > 100 ? "; host the API in the database's region" : ""}`);

    // ------------------------------------------------------------ connection headroom
    const [conn] = await h.sql<{ max: number; used: number; role_limit: number }[]>`
      select current_setting('max_connections')::int as max,
             (select count(*) from pg_stat_activity)::int as used,
             (select rolconnlimit from pg_roles where rolname = current_user)::int as role_limit`;
    const need = opts.poolMax * (opts.instances ?? 1) + 2;
    const limit = conn!.role_limit > 0 ? Math.min(conn!.role_limit, conn!.max) : conn!.max;
    add(
      "connections",
      need > limit - conn!.used ? "warn" : "pass",
      `DATABASE_POOL_MAX ${opts.poolMax} × ${opts.instances ?? 1} instance(s) + migrations needs ${need}; server max_connections ${conn!.max}, role limit ${conn!.role_limit < 0 ? "none" : conn!.role_limit}, in use ${conn!.used} (behind a pooler, the pooler's own limit applies)`,
    );

    // ------------------------------------------------------------ migrations
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    const applied = await h.sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`.then(
      (r) => r[0]!.n,
      () => 0,
    );
    const bundled = journal.entries.length;
    add("migrations", applied === bundled ? "pass" : applied < bundled ? "info" : "warn", applied === bundled ? `${applied}/${bundled} applied` : applied < bundled ? `${applied}/${bundled} applied; the API applies the rest at start` : `${applied} applied but this build bundles ${bundled}: the database is ahead of this build`);
  } catch (err) {
    add("checks", "fail", `${errCode(err)} ${errMsg(err)}`.trim());
  } finally {
    await h.close();
  }
  return out;
}

export async function verifyRedis(url: string, opts: { commandTimeoutMs: number }): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => out.push({ target: "redis", name, status, detail });
  let host: string;
  try {
    const u = new URL(url);
    host = u.hostname;
    if (isLocal(host)) add("tls", "info", `local host ${host}; TLS not required`);
    else add("tls", u.protocol === "rediss:" ? "pass" : "fail", u.protocol === "rediss:" ? "rediss:// (TLS; ioredis verifies the certificate)" : `redis:// to remote host ${host} is unencrypted; use rediss://`);
  } catch {
    add("connection string", "fail", "REDIS_URL is not a valid URL");
    return out;
  }
  const options = { lazyConnect: true, connectTimeout: 5_000, commandTimeout: opts.commandTimeoutMs, maxRetriesPerRequest: 1, enableOfflineQueue: false };
  const pub = new Redis(url, options);
  const sub = new Redis(url, options);
  // Connection errors surface through connect() below; without listeners ioredis also
  // prints them as "Unhandled error event".
  for (const c of [pub, sub]) c.on("error", () => {});
  try {
    await Promise.all([pub.connect(), sub.connect()]);
    const rtts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await pub.ping();
      rtts.push(performance.now() - t0);
    }
    add("ping", percentile(rtts, 95) > 100 ? "warn" : "pass", `p50 ${ms(percentile(rtts, 50))}, p95 ${ms(percentile(rtts, 95))} over 10 PINGs`);
    const version = await pub.info("server").then(
      (s) => /redis_version:(\S+)/.exec(s)?.[1] ?? "unknown",
      () => "INFO not permitted",
    );
    add("server", "info", `redis_version ${version}`);

    // The notifier's exact mechanism: PSUBSCRIBE on a pattern, PUBLISH from a pipeline. The
    // channel is outside the API's own pattern (ff:t:*), so live API instances never see it.
    const channel = `ff:verify:${process.pid}-${Date.now()}`;
    const got = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 5 s")), 5_000);
      sub.on("pmessage", (_p: string, ch: string) => {
        if (ch === channel) {
          clearTimeout(timer);
          resolve(performance.now());
        }
      });
    });
    await sub.psubscribe("ff:verify:*");
    const t0 = performance.now();
    await pub.pipeline().publish(channel, "1").exec();
    const t1 = await got;
    add("pub/sub", "pass", `PSUBSCRIBE + pipelined PUBLISH delivered in ${ms(t1 - t0)}`);
  } catch (err) {
    add("checks", "fail", errMsg(err));
  } finally {
    pub.disconnect();
    sub.disconnect();
  }
  return out;
}

export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", info: "INFO" };
  return checks.map((c) => `${mark[c.status]}  ${c.target.padEnd(8)} ${c.name.padEnd(36)} ${c.detail}`).join("\n");
}
