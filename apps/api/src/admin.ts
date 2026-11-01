#!/usr/bin/env node
/**
 * Operator CLI for bootstrapping without the dashboard.
 *   flowforge-admin create-tenant <slug> [name]
 *   flowforge-admin create-key <tenant-slug> <name> <scope,scope…>
 *   flowforge-admin revoke-key <prefix>
 * Requires DATABASE_URL. Prints a new API key exactly once.
 */
import { connect, migrate, schema } from "@flowforge/db";
import { and, eq, isNull } from "drizzle-orm";
import { SCOPES, generateApiKey, type Scope } from "./auth/tokens.js";

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

await migrate(url);
const h = connect(url, { max: 1, applicationName: "flowforge-admin" });
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
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.apiKeys.prefix, prefix), isNull(schema.apiKeys.revokedAt)))
        .returning({ id: schema.apiKeys.id });
      out(`revoked ${rows.length} key(s)`);
      break;
    }
    default:
      fail("commands: create-tenant, create-key, revoke-key");
  }
} finally {
  await h.close();
}
