#!/usr/bin/env node
// Run the API and the web app together on one host (for example one container or one
// platform service with a single public port). The web server takes the public port and
// forwards /api/* to the API, which listens on loopback only and trusts forwarding
// headers only from the web server.
//
//   npm run build && npm run build -w @flowforge/web && node scripts/start-single-host.mjs
//
// PORT (default 3000) is the public port. The web build bakes in its API address
// (API_INTERNAL_URL, default http://127.0.0.1:4000), so the API port is fixed at 4000.
// If either process exits, the other is stopped and this process exits non-zero, so the
// platform restarts the pair. SIGTERM is passed to both, and the API drains in-flight work.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const apiMain = join(root, "apps/api/dist/main.js");
const webDir = join(root, "apps/web");
const API_PORT = "4000";

for (const [file, hint] of [
  [apiMain, "npm run build"],
  [join(webDir, ".next/BUILD_ID"), "npm run build -w @flowforge/web"],
]) {
  if (!existsSync(file)) {
    process.stderr.write(`${file} not found: run \`${hint}\` first.\n`);
    process.exit(1);
  }
}

const publicPort = process.env.PORT ?? "3000";
if (publicPort === API_PORT) {
  process.stderr.write(`PORT ${API_PORT} is reserved for the API; choose another public port.\n`);
  process.exit(1);
}

const children = new Map();
let stopping = false;

function start(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      process.stderr.write(`${name} exited (${signal ?? `code ${code}`}); stopping the other process\n`);
      process.exitCode = code || 1;
      stop("SIGTERM");
    }
    if (children.size === 0) process.exit();
  });
}

function stop(signal) {
  stopping = true;
  for (const child of children.values()) child.kill(signal);
}

start("api", [apiMain], root, {
  API_HOST: "127.0.0.1",
  API_PORT,
  TRUST_PROXY: process.env.TRUST_PROXY ?? "127.0.0.1",
});
start("web", ["server.mjs"], webDir, {
  HOST: "0.0.0.0",
  PORT: publicPort,
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop(sig));
