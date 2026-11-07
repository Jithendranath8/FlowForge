import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Helpers for tests that run real processes: the API (`apps/api/dist/main.js`) and SDK
 * worker processes (`test/fixtures/e2e-worker.mjs`). Requires `npm run build` first.
 */

const API_MAIN = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const WORKER_FIXTURE = fileURLToPath(new URL("../fixtures/e2e-worker.mjs", import.meta.url));

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** Poll with a monotonic deadline (immune to wall-clock jumps). */
export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await cond())) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const exited = (c: ChildProcess) =>
  new Promise<number | null>((r) => (c.exitCode !== null || c.signalCode !== null ? r(c.exitCode) : c.once("exit", (code) => r(code))));

/**
 * Detects host suspension (or any freeze of this process). While a machine sleeps no
 * process runs. Which clock notices depends on the platform: on macOS Node's monotonic
 * clock keeps counting through sleep (libuv uses a continuous clock), on Linux
 * CLOCK_MONOTONIC stops and only the wall clock jumps. Either way, a ticker that should
 * fire every 100 ms sees a large gap on at least one clock, so the largest gap on
 * either clock is the signal. Lease expiry and every other deadline in the system are
 * wall-clock based, so timing assertions made across such a gap are meaningless.
 */
export class SuspensionDetector {
  private static readonly TICK_MS = 100;
  private lastMono = performance.now();
  private lastWall = Date.now();
  private maxGap = 0;
  private readonly timer = setInterval(() => this.tick(), SuspensionDetector.TICK_MS);

  constructor() {
    this.timer.unref();
  }

  private tick() {
    const mono = performance.now();
    const wall = Date.now();
    this.maxGap = Math.max(this.maxGap, mono - this.lastMono, wall - this.lastWall);
    this.lastMono = mono;
    this.lastWall = wall;
  }

  /** Largest stall seen so far, in ms (beyond the expected tick interval). */
  maxStallMs(): number {
    this.tick();
    return Math.max(0, this.maxGap - SuspensionDetector.TICK_MS);
  }

  suspended(thresholdMs = 1_500): boolean {
    return this.maxStallMs() > thresholdMs;
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * Run a timing-sensitive scenario. If it fails *and* this process was frozen for more
 * than 1.5 s during the attempt (host suspended), the attempt is inconclusive and is
 * re-run, up to `attempts`. A failure without a freeze is a real failure and is rethrown
 * at once, so this cannot mask genuine flakiness. If every attempt was frozen, the test
 * fails with an explicit "inconclusive" error rather than passing.
 */
export async function retryIfSuspended(attempts: number, scenario: (attempt: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const clock = new SuspensionDetector();
    try {
      await scenario(attempt);
      return;
    } catch (err) {
      const stall = Math.round(clock.maxStallMs());
      if (!clock.suspended()) throw err;
      if (attempt >= attempts) {
        throw new Error(
          `Inconclusive: the host was suspended (process frozen for up to ${stall} ms) during all ${attempts} attempts. ` +
            "Timing-dependent scenarios need an awake machine (or CI).",
          { cause: err },
        );
      }
      console.warn(`[suspension] attempt ${attempt} ran across a ${stall} ms process freeze; retrying`);
    } finally {
      clock.stop();
    }
  }
}

export interface ApiProcess {
  url: string;
  port: number;
  /** Prometheus endpoint of this process (its own listener). */
  metricsUrl: string;
  proc: ChildProcess;
  /** Stop the process with the given signal and wait for it to exit. */
  stop(signal?: NodeJS.Signals): Promise<{ code: number | null; ms: number }>;
  /** Start a fresh process on the same port with the same environment. */
  restart(): Promise<void>;
  stderr: () => string;
}

export async function startApi(env: Record<string, string>, port?: number): Promise<ApiProcess> {
  if (!existsSync(API_MAIN)) throw new Error(`${API_MAIN} missing: run \`npm run build\` first`);
  const p = port ?? (await freePort());
  const url = `http://127.0.0.1:${p}`;
  const metricsPort = env.METRICS_PORT ?? String(await freePort());
  let stderr = "";
  const spawnOne = async () => {
    const proc = spawn(process.execPath, [API_MAIN], {
      env: {
        PATH: process.env.PATH ?? "",
        API_HOST: "127.0.0.1",
        API_PORT: String(p),
        LOG_LEVEL: "warn",
        SESSION_SECRET: "x".repeat(40),
        METRICS_PORT: metricsPort,
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr!.on("data", (d) => (stderr += d));
    await waitUntil(
      async () => {
        if (proc.exitCode !== null) throw new Error(`API exited during startup: ${stderr}`);
        return fetch(`${url}/health`).then((r) => r.ok, () => false);
      },
      20_000,
      "API /health",
    );
    return proc;
  };
  const api: ApiProcess = {
    url,
    port: p,
    metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`,
    proc: await spawnOne(),
    async stop(signal = "SIGTERM") {
      const t0 = performance.now();
      if (api.proc.exitCode === null && api.proc.signalCode === null) api.proc.kill(signal);
      const code = await exited(api.proc);
      return { code, ms: performance.now() - t0 };
    },
    async restart() {
      api.proc = await spawnOne();
    },
    stderr: () => stderr,
  };
  return api;
}

export interface Execution {
  pid: number;
  runId: string;
  key: string;
  attempt: number;
  event: string;
}

/** Spawns SDK worker processes that log every handler start/finish to one file. */
export class WorkerPool {
  readonly logFile: string;
  readonly children: ChildProcess[] = [];

  constructor() {
    this.logFile = join(mkdtempSync(join(tmpdir(), "ff-proc-")), "executions.log");
    writeFileSync(this.logFile, "");
  }

  async start(opts: { apiUrl: string; apiKey: string; name: string; concurrency?: number; trace?: boolean }): Promise<ChildProcess> {
    const child = spawn(process.execPath, [WORKER_FIXTURE], {
      env: {
        ...process.env,
        FLOWFORGE_API_URL: opts.apiUrl,
        FLOWFORGE_API_KEY: opts.apiKey,
        E2E_LOG: this.logFile,
        WORKER_NAME: opts.name,
        CONCURRENCY: String(opts.concurrency ?? 4),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => {
      stderr += d;
      if (process.env.E2E_TRACE) appendFileSync(`${this.logFile}.stderr`, `[${opts.name}] ${d}`);
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
      child.once("exit", (code) => reject(new Error(`worker ${opts.name} exited (${code}): ${stderr}`)));
    });
    return child;
  }

  executions(): Execution[] {
    return readFileSync(this.logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [pid, runId, key, attempt, event] = l.split(" ");
        return { pid: Number(pid), runId: runId!, key: key!, attempt: Number(attempt), event: event! };
      });
  }

  /** Clear the execution log between scenario attempts. */
  resetLog() {
    writeFileSync(this.logFile, "");
  }

  killAll() {
    for (const c of this.children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
}
