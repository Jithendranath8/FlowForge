#!/usr/bin/env node
/**
 * Operator CLI for bootstrapping without the dashboard.
 *   flowforge-admin create-tenant <slug> [name]
 *   flowforge-admin create-key <tenant-slug> <name> <scope,scope…>
 *   flowforge-admin revoke-key <prefix>
 *   flowforge-admin show-quota <tenant-slug>
 *   flowforge-admin set-quota <tenant-slug> <quota> <value>
 *   flowforge-admin add-member <tenant-slug> <email> <owner|admin|member|viewer>
 *       (the user gets access when they first sign in with that verified email)
 *   flowforge-admin remove-member <tenant-slug> <email>   (also ends their sessions in that workspace)
 *   flowforge-admin revoke-sessions <email>               (signs the user out everywhere)
 *   flowforge-admin retention [--apply]   (RETENTION_* variables; reports only without --apply)
 *   flowforge-admin verify [--instances N] [--json]   (checks DATABASE_URL and REDIS_URL; read-only, no migrations)
 * Requires DATABASE_URL. Prints a new API key exactly once.
 */
import { DEFAULT_DB_TIMEOUTS, connect, migrate, schema } from "@flowforge/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AccessError, endSessions, removeMember } from "./auth/accounts.js";
import { SCOPES, generateApiKey, type Scope } from "./auth/tokens.js";
import { ConfigError, loadRetentionPolicy } from "./config.js";
import { QUOTAS, tenantQuotaReport, type QuotaName } from "./engine/quotas.js";
import { applyRetention, retentionBacklog, type RetentionResult } from "./engine/retention.js";
import { postgresTimeSource } from "./infra/clock.js";
import { formatChecks, verifyPostgres, verifyRedis } from "./verify.js";

const [cmd, ...args] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is required");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
function out(msg: string) {
  process.stdout.write(`${msg}\n`);
}

/** A non-negative integer setting from the environment (the same variables the API reads). */
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer`);
  return n;
}
// Server-side timeouts as the API sends them: behind a pooler that rejects startup
// parameters both are set to 0 (and configured on the database role instead).
const statementTimeoutMs = num("DATABASE_STATEMENT_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.statementTimeoutMs);
const idleInTransactionTimeoutMs = num("DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", DEFAULT_DB_TIMEOUTS.idleInTransactionTimeoutMs);

if (cmd === "verify") {
  // Read-only, and before migrate(): verifying a deployment must not change it.
  const i = args.indexOf("--instances");
  const instances = i >= 0 ? Number(args[i + 1]) : 1;
  if (!Number.isInteger(instances) || instances < 1) fail("--instances must be a positive integer");
  const checks = await verifyPostgres(url, {
    statementTimeoutMs,
    idleInTransactionTimeoutMs,
    poolMax: num("DATABASE_POOL_MAX", 10),
    instances,
  });
  if (process.env.REDIS_URL) checks.push(...(await verifyRedis(process.env.REDIS_URL, { commandTimeoutMs: num("REDIS_COMMAND_TIMEOUT_MS", 1_000) })));
  else checks.push({ target: "redis", name: "configured", status: "info", detail: "REDIS_URL not set: workers poll (correct, slower wake-ups)" });
  out(args.includes("--json") ? JSON.stringify(checks, null, 2) : formatChecks(checks));
  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
}

await migrate(url);
const h = connect(url, { max: 1, applicationName: "flowforge-admin", statementTimeoutMs, idleInTransactionTimeoutMs });
try {
  switch (cmd) {
    case "create-tenant": {
      const [slug, name] = args;
      if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) fail("usage: create-tenant <slug> [name]  (slug: lowercase letters, digits, dashes)");
      const [t] = await h.db.insert(schema.tenants).values({ slug, name: name ?? slug }).onConflictDoNothing().returning();
      if (!t) fail(`tenant ${slug} already exists`);
      out(`tenant ${t.slug} ${t.id}`);
      break;
    }
    case "create-key": {
      const [slug, name, scopeArg] = args;
      if (!slug || !name || !scopeArg) fail(`usage: create-key <tenant-slug> <name> <scopes>  (scopes: ${SCOPES.join(",")})`);
      const scopes = scopeArg.split(",").map((s) => s.trim());
      const bad = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
      if (bad.length) fail(`unknown scopes: ${bad.join(", ")}`);
      const [t] = await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
      if (!t) fail(`tenant ${slug} not found`);
      const k = generateApiKey();
      await h.db.insert(schema.apiKeys).values({ tenantId: t.id, name, prefix: k.prefix, hash: k.hash, scopes: scopes as Scope[] });
      out(k.key);
      console.error(`created key ${k.prefix} for ${slug} with scopes ${scopes.join(",")} — store it now, it is not shown again`);
      break;
    }
    case "revoke-key": {
      const [prefix] = args;
      if (!prefix) fail("usage: revoke-key <prefix>");
      const rows = await h.db
        .update(schema.apiKeys)
        .set({ revokedAt: sql`clock_timestamp()` }) // the database clock: engine time in production (ADR-015)
        .where(and(eq(schema.apiKeys.prefix, prefix), isNull(schema.apiKeys.revokedAt)))
        .returning({ id: schema.apiKeys.id });
      out(`revoked ${rows.length} key(s)`);
      break;
    }
    case "show-quota": {
      const [slug] = args;
      if (!slug) fail("usage: show-quota <tenant-slug>");
      const [t] = await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
      if (!t) fail(`tenant ${slug} not found`);
      out(JSON.stringify((await tenantQuotaReport(h.db, t.id)).quotas, null, 2));
      break;
    }
    case "set-quota": {
      const [slug, quota, value] = args;
      const names = Object.keys(QUOTAS).join(", ");
      if (!slug || !quota || !value) fail(`usage: set-quota <tenant-slug> <quota> <value>  (quotas: ${names})`);
      if (!Object.hasOwn(QUOTAS, quota)) fail(`unknown quota ${quota} (quotas: ${names})`);
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) fail("value must be an integer from 0 to 1000000");
      const rows = await h.db
        .update(schema.tenants)
        .set({ [QUOTAS[quota as QuotaName]]: n })
        .where(eq(schema.tenants.slug, slug))
        .returning({ id: schema.tenants.id });
      if (rows.length === 0) fail(`tenant ${slug} not found`);
      out(`${slug} ${quota}=${n}`);
      break;
    }
    case "add-member": {
      const [slug, rawEmail, role] = args;
      const roles = ["owner", "admin", "member", "viewer"] as const;
      if (!slug || !rawEmail || !role) fail("usage: add-member <tenant-slug> <email> <owner|admin|member|viewer>");
      if (!(roles as readonly string[]).includes(role)) fail(`role must be one of ${roles.join(", ")}`);
      const email = rawEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`not an email address: ${rawEmail}`);
      const [t] = await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
      if (!t) fail(`tenant ${slug} not found`);
      // Pre-provision the user by email; sign-in links the verified identity to it (ADR-018).
      await h.db.insert(schema.users).values({ email }).onConflictDoNothing();
      const [u] = await h.db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
      await h.db
        .insert(schema.memberships)
        .values({ tenantId: t.id, userId: u!.id, role: role as (typeof roles)[number] })
        .onConflictDoUpdate({ target: [schema.memberships.tenantId, schema.memberships.userId], set: { role: role as (typeof roles)[number] } });
      out(`${email} is ${role} of ${slug}`);
      break;
    }
    case "remove-member": {
      const [slug, rawEmail] = args;
      if (!slug || !rawEmail) fail("usage: remove-member <tenant-slug> <email>");
      const email = rawEmail.trim().toLowerCase();
      const [t] = await h.db.select().from(schema.tenants).where(eq(schema.tenants.slug, slug));
      if (!t) fail(`tenant ${slug} not found`);
      const [u] = await h.db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
      if (!u) fail(`no user with email ${email}`);
      try {
        const r = await removeMember(h.db, t.id, u.id);
        out(`removed ${email} from ${slug}; ended ${r.sessionsEnded} session(s)`);
      } catch (err) {
        if (err instanceof AccessError) fail(err.code === "last_owner" ? `${email} is the last owner of ${slug}: make someone else an owner first` : `${email} is not a member of ${slug}`);
        throw err;
      }
      break;
    }
    case "revoke-sessions": {
      const [rawEmail] = args;
      if (!rawEmail) fail("usage: revoke-sessions <email>");
      const email = rawEmail.trim().toLowerCase();
      const [u] = await h.db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
      if (!u) fail(`no user with email ${email}`);
      out(`ended ${await endSessions(h.db, u.id)} session(s) of ${email}`);
      break;
    }
    case "retention": {
      const apply = args.includes("--apply");
      let policy;
      try {
        policy = loadRetentionPolicy();
      } catch (err) {
        fail(err instanceof ConfigError ? err.message : String(err));
      }
      // Engine time is the database clock (ADR-015); read it once.
      const nowMs = await postgresTimeSource(h.db)();
      const rctx = { db: h.db, now: () => new Date(nowMs) };
      out(JSON.stringify({ policy, eligible: await retentionBacklog(rctx, policy) }, null, 2));
      if (!apply) {
        console.error("report only: re-run with --apply to delete");
        break;
      }
      let r: RetentionResult;
      const total: Record<string, number> = {};
      do {
        r = await applyRetention(rctx, policy);
        for (const [k, n] of Object.entries(r.deleted)) total[k] = (total[k] ?? 0) + n;
      } while (!r.complete);
      out(JSON.stringify({ deleted: total }, null, 2));
      break;
    }
    default:
      fail("commands: create-tenant, create-key, revoke-key, show-quota, set-quota, add-member, remove-member, revoke-sessions, retention, verify");
  }
} finally {
  await h.close();
}
