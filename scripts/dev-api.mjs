#!/usr/bin/env node
// Run the built API locally with configuration from `.env` and `.env.credentials`
// (both git-ignored; the credentials file wins). Values still containing REPLACE_ME are
// treated as unset, so a provider with a placeholder secret stays "not configured".
//   npm run build && npm run dev:api
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const root = new URL("..", import.meta.url).pathname;
const load = (file) => (existsSync(join(root, file)) ? parseEnv(readFileSync(join(root, file), "utf8")) : {});
const fromFiles = { ...load(".env"), ...load(".env.credentials") };
const env = { ...process.env };
for (const [k, v] of Object.entries(fromFiles)) {
  if (k.startsWith("HOSTED_")) continue; // read by `npm run verify:hosted`, not by the API
  if (typeof v === "string" && !v.includes("REPLACE_ME") && !v.startsWith("<")) env[k] ??= v;
}
// A provider needs both halves; with one missing, leave it off (and say so) rather than
// fail startup, so one provider can be set up before the other.
for (const p of ["GOOGLE", "GITHUB"]) {
  const id = env[`${p}_CLIENT_ID`];
  const secret = env[`${p}_CLIENT_SECRET`];
  if (Boolean(id) !== Boolean(secret)) {
    process.stderr.write(`dev-api: ${p.toLowerCase()} sign-in is off: ${id ? `${p}_CLIENT_SECRET` : `${p}_CLIENT_ID`} is not set in .env.credentials\n`);
    delete env[`${p}_CLIENT_ID`];
    delete env[`${p}_CLIENT_SECRET`];
  }
}
const main = join(root, "apps/api/dist/main.js");
if (!existsSync(main)) {
  process.stderr.write("apps/api/dist/main.js not found: run `npm run build` first.\n");
  process.exit(1);
}
const child = spawn(process.execPath, [main], { env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
