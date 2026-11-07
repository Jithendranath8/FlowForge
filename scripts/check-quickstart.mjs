#!/usr/bin/env node
// Runs the install steps shown on the homepage and in the quick start
// (apps/web/src/lib/examples.ts), in order, on a fresh copy of this working tree with
// fresh PostgreSQL and Redis containers, and checks that the quick-start run succeeds.
//
//   npm run check:quickstart [-- --log <file>] [-- --keep]
//
// Differences from a reader's machine, each printed in the log:
// - "git clone" is replaced by copying this working tree (tracked and untracked files
//   that git does not ignore), so unpushed changes are what gets checked;
// - Docker Compose runs under its own project name, so its volumes start empty and the
//   containers are removed afterwards (--keep leaves the copy and containers in place).
//
// It needs the ports the steps use to be free (4000, 54329, 63799): stop a running dev
// API and `docker compose stop` first. It does not touch any other containers.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const logFile = args.includes("--log") ? resolve(args[args.indexOf("--log") + 1]) : join(repo, "quickstart-check.log");
const keep = args.includes("--keep");
const project = `flowforge-quickstart-check-${Date.now()}`;
const started = Date.now();

writeFileSync(logFile, "");
const redact = (s) => s.replace(/ffk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}/g, (k) => `${k.slice(0, 13)}<redacted>`);
const log = (line = "") => {
  const text = redact(line);
  process.stdout.write(`${text}\n`);
  appendFileSync(logFile, `${text}\n`);
};
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;

const portOpen = (port) =>
  new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), done(true)));
    s.once("error", () => done(false));
  });

// The steps exactly as the site shows them.
const steps = JSON.parse(
  execFileSync("npx", ["tsx", "-e", 'import("./apps/web/src/lib/examples.ts").then((m) => process.stdout.write(JSON.stringify(m.installSteps)))'], { cwd: repo, encoding: "utf8" }),
);

let base;
const background = [];
const keys = {};
let cwd = null;
const env = { ...process.env, COMPOSE_PROJECT_NAME: project, FORCE_COLOR: "0", NO_COLOR: "1" };
for (const k of Object.keys(env)) if (/^(FLOWFORGE_|DATABASE_|REDIS_|SESSION_|GOOGLE_|GITHUB_|AUTH_)/.test(k)) delete env[k];

function run(command, { capture = false } = {}) {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const tail = out.trim().split("\n").slice(-12).join("\n");
      log(`  exit ${code} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (tail) log(tail.replace(/^/gm, "  | "));
      if (code === 0) done(out);
      else fail(new Error(`"${command}" exited with ${code}`));
    });
    if (!capture) child.stdin?.end();
  });
}

function startBackground(command, name) {
  const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  background.push({ child, name, output: () => out });
  log(`  started in the background (pid ${child.pid})`);
  return child;
}

async function waitFor(what, test, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function copyTree(dest) {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  let n = 0;
  for (const f of files) {
    try {
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      copyFileSync(join(repo, f), join(dest, f));
      n++;
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // deleted but still listed by git
    }
  }
  return n;
}

async function main() {
  log(`FlowForge quick-start check, ${new Date().toISOString()}`);
  log(`node ${process.version}; compose project ${project}`);
  for (const port of [4000, 54329, 63799]) {
    if (await portOpen(port)) throw new Error(`port ${port} is in use: stop the dev API and run "docker compose stop" first`);
  }
  base = mkdtempSync(join(tmpdir(), "flowforge-quickstart-"));
  cwd = base;

  for (const [i, step] of steps.entries()) {
    log();
    log(`## ${i + 1}. ${step.title}  [${elapsed()}]`);
    for (const raw of step.code.split("\n")) {
      let command = raw.trim();
      if (!command) continue;
      if (command.startsWith("git clone ")) {
        const dest = join(base, "FlowForge");
        log(`$ ${command}`);
        log(`  substituted: copied ${await copyTree(dest)} files of this working tree to ${dest}`);
        continue;
      }
      if (command.startsWith("cd ")) {
        cwd = resolve(cwd, command.slice(3).trim());
        log(`$ ${command}`);
        continue;
      }
      command = command.replaceAll("<worker key>", keys.worker ?? "<worker key>").replaceAll("<cli key>", keys.cli ?? "<cli key>");
      log(`$ ${command}`);
      if (command === "npm run dev:api") {
        const api = startBackground(command, "api");
        await waitFor("the API on :4000", async () => {
          if (api.exitCode !== null) throw new Error(`the API exited:\n${background.at(-1).output()}`);
          return fetch("http://127.0.0.1:4000/health").then((r) => r.ok, () => false);
        }, 60_000);
        log("  the API answers GET /health");
        continue;
      }
      if (command.includes("npm run worker")) {
        const worker = startBackground(command, "worker");
        await waitFor("the worker to register", async () => {
          if (worker.exitCode !== null) throw new Error(`the worker exited:\n${background.at(-1).output()}`);
          return /polling for tasks/.test(background.at(-1).output());
        }, 60_000);
        log("  the worker registered");
        continue;
      }
      const out = await run(command);
      const created = /create-key \S+ (\S+) /.exec(command);
      if (created) {
        const key = /ffk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}/.exec(out)?.[0];
        if (!key) throw new Error(`no key in the output of "${command}"`);
        keys[created[1]] = key;
      }
      if (command.includes("run-workflow")) {
        if (!/run succeeded/.test(out)) throw new Error("the quick-start run did not succeed");
        for (const [task, state] of [["extract", "succeeded"], ["clean", "succeeded"], ["enrich", "succeeded"], ["load", "succeeded"], ["notify", "skipped"]]) {
          if (!new RegExp(`${task}\\s+${state}`).test(out)) throw new Error(`expected ${task} ${state}`);
        }
        log("  checked: run succeeded; extract, clean, enrich and load succeeded; notify skipped");
      }
      if (command.startsWith("curl ")) {
        if (!/"runs":\s*\[/.test(out) || !/daily-report/.test(out)) throw new Error("GET /v1/runs did not list the run");
        log("  checked: GET /v1/runs lists the daily-report run");
      }
    }
  }
  log();
  log(`PASS: every install step ran and the quick-start run succeeded, in ${elapsed()}`);
}

async function teardown() {
  for (const { child } of background.reverse()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 2_000));
  if (keep) {
    log(`kept: ${base} and compose project ${project}`);
    return;
  }
  if (!base) return;
  const dir = join(base, "FlowForge");
  try {
    execFileSync("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans"], { cwd: dir, stdio: "ignore" });
    log(`removed compose project ${project} and its volumes`);
  } catch {
    log(`could not remove compose project ${project}; remove it with: docker compose -p ${project} down -v`);
  }
}

try {
  await main();
  await teardown();
} catch (err) {
  log();
  log(`FAIL after ${elapsed()}: ${err.message}`);
  for (const b of background) log(`--- ${b.name} output (last lines) ---\n${b.output().trim().split("\n").slice(-20).join("\n")}`);
  await teardown();
  process.exitCode = 1;
}
