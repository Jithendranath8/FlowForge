#!/usr/bin/env node
// The web app's production server: Next.js's own request handler behind a plain Node
// HTTP server, so every request's forwarding headers are set from the real connection
// before Next forwards /api/* to the FlowForge API (see forwarding.mjs).
//
//   node server.mjs            (npm start)
//   PORT=3000 HOST=0.0.0.0 WEB_TRUST_PROXY=1 node server.mjs
//
// Pair it with TRUST_PROXY=<this server's address> on the API (for example 127.0.0.1
// when both run on one host), so the API believes X-Forwarded-For only from here.
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import { parseWebTrust, rewriteForwarding } from "./forwarding.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const trust = parseWebTrust(process.env.WEB_TRUST_PROXY);

const app = next({ dev: false, dir, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  rewriteForwarding(req, trust);
  handle(req, res).catch((err) => {
    console.error("request failed", err);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});
server.listen(port, hostname, () => {
  console.warn(`web: listening on http://${hostname}:${port} (WEB_TRUST_PROXY=${process.env.WEB_TRUST_PROXY ?? "false"})`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    // Live streams hold connections open; do not wait for them.
    server.closeAllConnections?.();
  });
}
