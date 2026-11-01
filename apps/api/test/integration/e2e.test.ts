import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema, type DbHandle } from "@flowforge/db";
import { FlowForgeClient } from "@flowforge/sdk";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { runMaintenanceOnce } from "../../src/engine/maintenance.js";
import { buildApp } from "../../src/http/app.js";
import { RedisNotifier } from "../../src/infra/notifier.js";
import { REDIS_TEST_URL, createApiKey, createTenant, resetData, setupDatabase } from "./harness.js";

/*
 * End-to-end tests with real worker *processes* (the SDK runtime) against a real API
 * server, Postgres and Redis. Lease/heartbeat timings are shortened so crash recovery
 * completes within seconds.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/e2e-worker.mjs", import.meta.url));
const LEASE_MS = 2_500;

let h: DbHandle;
let app: FastifyInstance;
let notifier: RedisNotifier;
let address: string;
let maintenance: NodeJS.Timeout;
let maintenanceTick: Promise<unknown> = Promise.resolve();
let client: FlowForgeClient;
let workerKey: string;
let logFile: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  h = await setupDatabase();
  notifier = new RedisNotifier(REDIS_TEST_URL, pino({ level: "silent" }));
  const ctx: EngineContext = {
    db: h.db,
    now: () => new Date(),
    notifier,
    log: pino({ level: "silent" }),
    leaseDurationMs: LEASE_MS,
    heartbeatIntervalMs: 500,
    workerOfflineAfterMs: 5_000,
  };
  app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 1 << 20, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "silent" }, ctx });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  let busy = false;
  maintenance = setInterval(() => {
    if (busy) return;
    busy = true;
    maintenanceTick = runMaintenanceOnce(ctx).finally(() => (busy = false));
  }, 150);
});

afterAll(async () => {
  clearInterval(maintenance);
  await maintenanceTick.catch(() => {}); // never close the pool under an in-flight tick
  await app?.close();
  await notifier?.close();
  await h?.close();
});

beforeEach(async () => {
  await resetData(h);
  const tenant = await createTenant(h, "e2e");
  client = new FlowForgeClient({ apiUrl: address, apiKey: await createApiKey(h, tenant, ["read", "workflows:write", "runs:write"]) });
  workerKey = await createApiKey(h, tenant, ["worker"]);
  logFile = join(mkdtempSync(join(tmpdir(), "ff-e2e-")), "executions.log");
  writeFileSync(logFile, "");
  if (process.env.E2E_TRACE) console.warn(`[trace] logs in ${logFile} api ${address}`);
});

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

async function startWorker(name: string, concurrency = 4): Promise<ChildProcess> {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, FLOWFORGE_API_URL: address, FLOWFORGE_API_KEY: workerKey, E2E_LOG: logFile, WORKER_NAME: name, CONCURRENCY: String(concurrency) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (d) => {
    stderr += d;
    if (process.env.E2E_TRACE) appendFileSync(`${logFile}.stderr`, `[${name}] ${d}`);
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
    child.once("exit", (code) => reject(new Error(`worker ${name} exited (${code}): ${stderr}`)));
  });
  return child;
}

interface Execution {
  pid: number;
  runId: string;
  key: string;
  attempt: number;
  event: string;
}
const executions = (): Execution[] =>
  readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [pid, runId, key, attempt, event] = l.split(" ");
      return { pid: Number(pid), runId: runId!, key: key!, attempt: Number(attempt), event: event! };
    });

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function dumpDiagnostics(runId: string) {
  const out = (label: string, v: unknown) => console.warn(`[diag] ${label}: ${JSON.stringify(v)}`);
  out("node now", new Date().toISOString());
  out("pg now", (await h.sql`select clock_timestamp() as t`)[0]);
  out("tasks", await h.sql`select key, state, attempts, fence, worker_id, lease_expires_at, available_at, enqueued_at from tasks where run_id = ${runId}`);
  out("attempts", await h.sql`select attempt, outcome, worker_id, started_at, finished_at from task_attempts where run_id = ${runId}`);
  out("workers", await h.sql`select id, name, state, last_heartbeat_at from workers`);
  out("events", await h.sql`select id, type, created_at from events where run_id = ${runId} order by id`);
  out("outbox unpublished", await h.sql`select count(*)::int as n from outbox where published_at is null`);
  out("redis healthy", notifier.healthy());
  const health = await fetch(`${address}/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.status).catch((e) => String(e));
  out("api /health", health);
  out("execution log", readFileSync(logFile, "utf8"));
}

const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null ? r(c.exitCode) : c.once("exit", (code) => r(code))));

describe("end-to-end with worker processes", () => {
  it("distributes a fan-out/fan-in workflow across workers, executing each task once", async () => {
    await client.registerWorkflow({
      name: "fan",
      tasks: [
        { key: "split", type: "e2e.step" },
        ...[1, 2, 3, 4, 5].map((i) => ({ key: `part${i}`, type: "e2e.step", dependsOn: ["split"], input: { ms: 60 } })),
        { key: "merge", type: "e2e.step", dependsOn: ["part1", "part2", "part3", "part4", "part5"] },
      ],
    });
    await Promise.all([startWorker("a"), startWorker("b"), startWorker("c")]);
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => client.startRun("fan", { input: { i } })));
    const results = await Promise.all(runs.map((r) => client.waitForRun(r.id, { timeoutMs: 30_000, intervalMs: 100 })));

    expect(results.every((r) => r.run.state === "succeeded")).toBe(true);
    const done = executions().filter((e) => e.event === "done");
    expect(done).toHaveLength(8 * 7);
    expect(new Set(done.map((e) => `${e.runId}:${e.key}`)).size).toBe(8 * 7); // no duplicates
    expect(new Set(done.map((e) => e.pid)).size).toBeGreaterThan(1); // distributed

    // merge always starts after every part of the same run finished.
    for (const r of runs) {
      const log = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes(r.id));
      const mergeStart = log.findIndex((l) => l.includes(" merge ") && l.endsWith("start"));
      const lastPartDone = Math.max(...[1, 2, 3, 4, 5].map((i) => log.findIndex((l) => l.includes(` part${i} `) && l.endsWith("done"))));
      expect(mergeStart).toBeGreaterThan(lastPartDone);
    }
  });

  it("recovers a task from a worker killed with SIGKILL mid-execution", { timeout: 40_000 }, async () => {
    await client.registerWorkflow({
      name: "crashy",
      tasks: [{ key: "hang", type: "e2e.hang", retry: { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1_000, backoffCoefficient: 2, jitter: 0 } }],
    });
    const T0 = Date.now(); const phase = (p: string) => process.env.E2E_TRACE && console.warn(`[trace] ${Date.now() - T0}ms ${p}`);
    const victim = await startWorker("victim", 1);
    phase("victim ready");
    const run = await client.startRun("crashy", { input: { hangMs: 1_500 } });
    phase("run started");
    await waitUntil(() => executions().some((e) => e.event === "start"), 10_000, "task to start on victim");
    phase("task started");
    expect(executions()[0]!.pid).toBe(victim.pid);

    const killedAt = Date.now();
    victim.kill("SIGKILL"); // no graceful shutdown, no deregistration
    await exited(victim);
    phase("victim dead");
    const survivor = await startWorker("survivor", 1);
    phase("survivor ready");

    const final = await client.waitForRun(run.id, { timeoutMs: 12_000, intervalMs: 100 }).catch(async (err) => {
      if (process.env.E2E_TRACE) await dumpDiagnostics(run.id);
      throw err;
    });
    phase("run finished " + final.run.state);
    const recoveryMs = Date.now() - killedAt;
    expect(final.run.state).toBe("succeeded");
    expect(final.tasks[0]!.attempts).toBe(2);
    const done = executions().filter((e) => e.event === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ pid: survivor.pid, attempt: 2 });

    const attempts = await h.db.select().from(schema.taskAttempts).where(eq(schema.taskAttempts.taskId, final.tasks[0]!.id));
    expect(attempts.map((a) => a.outcome).sort()).toEqual(["lease_expired", "succeeded"]);
    // Bounded by lease (2.5s) + maintenance tick + retry delay + execution (1.5s).
    expect(recoveryMs).toBeLessThan(LEASE_MS + 4_000);
    console.warn(`[e2e] SIGKILL recovery: run succeeded ${recoveryMs} ms after kill (lease ${LEASE_MS} ms, task 1500 ms)`);
  });

  it("drains in-flight work on SIGTERM before exiting", async () => {
    await client.registerWorkflow({ name: "drain", tasks: [{ key: "hang", type: "e2e.hang" }] });
    const w = await startWorker("graceful", 1);
    const run = await client.startRun("drain", { input: { hangMs: 1_200 } });
    await waitUntil(() => executions().some((e) => e.event === "start"), 10_000, "task start");
    w.kill("SIGTERM");
    expect(await exited(w)).toBe(0);
    const final = await client.getRun(run.id);
    expect(final.run.state).toBe("succeeded");
    expect(final.tasks[0]!.attempts).toBe(1);
    const [row] = await h.db.select().from(schema.workers);
    expect(row!.state).toBe("offline");
  });

  it("retries a failing attempt and completes", async () => {
    await client.registerWorkflow({
      name: "flaky",
      tasks: [{ key: "f", type: "e2e.flaky", retry: { maxAttempts: 2, initialDelayMs: 200, maxDelayMs: 200, backoffCoefficient: 1, jitter: 0 } }],
    });
    await startWorker("w", 2);
    const run = await client.startRun("flaky");
    const final = await client.waitForRun(run.id, { timeoutMs: 10_000, intervalMs: 100 });
    expect(final.run.state).toBe("succeeded");
    expect(executions().map((e) => `${e.attempt}:${e.event}`)).toEqual(["1:start", "2:start", "2:done"]);
  });
});
