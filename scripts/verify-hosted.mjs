#!/usr/bin/env node
// Verify hosted Postgres and Redis with `flowforge-admin verify`, using the connection
// strings in `.env.credentials` (git-ignored; template: `.env.credentials.example`).
//
//   npm run build && npm run verify:hosted [-- --env <file>] [-- --out <dir>]
//
// Values that still contain REPLACE_ME are skipped. Credentials are never printed: the
// verify report contains no connection strings. Each report is saved under
// docs/audit/evidence/hosted/ (override with --out).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const root = new URL("..", import.meta.url).pathname;
const say = (msg) => process.stdout.write(`${msg}\n`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const envFile = arg("--env", join(root, ".env.credentials"));
const outDir = arg("--out", join(root, "docs/audit/evidence/hosted"));
const admin = join(root, "apps/api/dist/admin.js");

if (!existsSync(envFile)) {
  console.error(`${envFile} not found. Copy .env.credentials.example to .env.credentials and fill it in.`);
  process.exit(1);
}
if (!existsSync(admin)) {
  console.error("apps/api/dist/admin.js not found: run `npm run build` first.");
  process.exit(1);
}

const vars = parseEnv(readFileSync(envFile, "utf8"));
const filled = (name) => {
  const v = vars[name];
  return v && !v.includes("REPLACE_ME") ? v : null;
};

const pending = ["HOSTED_DATABASE_URL", "HOSTED_DATABASE_URL_DIRECT", "HOSTED_REDIS_URL"].filter((n) => !filled(n));
if (pending.length) say(`Not filled in yet (skipped): ${pending.join(", ")}`);

const targets = [
  ["pooled", filled("HOSTED_DATABASE_URL")],
  ["direct", filled("HOSTED_DATABASE_URL_DIRECT")],
].filter(([, url]) => url);
if (targets.length === 0) {
  say(`Nothing to verify yet: fill HOSTED_DATABASE_URL (and HOSTED_REDIS_URL) in ${envFile}.`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
let failed = false;
for (const [label, url] of targets) {
  const env = {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: url,
    ...(filled("HOSTED_DATABASE_STATEMENT_TIMEOUT_MS") ? { DATABASE_STATEMENT_TIMEOUT_MS: filled("HOSTED_DATABASE_STATEMENT_TIMEOUT_MS") } : {}),
    ...(filled("HOSTED_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS")
      ? { DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: filled("HOSTED_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS") }
      : {}),
    // Redis is checked once, with the pooled (production) database run.
    ...(label === "pooled" && filled("HOSTED_REDIS_URL") ? { REDIS_URL: filled("HOSTED_REDIS_URL") } : {}),
  };
  const r = spawnSync(process.execPath, [admin, "verify"], { env, encoding: "utf8", timeout: 120_000 });
  const report = `# flowforge-admin verify — ${label} database${env.REDIS_URL ? " + Redis" : ""} — ${new Date().toISOString()}\n${r.stdout}${r.stderr}exit=${r.status}\n`;
  const file = join(outDir, `verify-${stamp}-${label}.log`);
  writeFileSync(file, report);
  say(`\n${report}saved: ${file}`);
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
