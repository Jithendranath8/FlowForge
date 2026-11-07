// Worker process used by the end-to-end tests. Every handler appends
// "<pid> <runId> <key> <attempt> <event>" to E2E_LOG so tests can assert on executions.
import { appendFileSync } from "node:fs";
import { createWorker } from "@flowforge/sdk";

const log = (ctx, event) => appendFileSync(process.env.E2E_LOG, `${process.pid} ${ctx.runId} ${ctx.key} ${ctx.attempt} ${event}\n`);
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

const worker = createWorker({
  apiUrl: process.env.FLOWFORGE_API_URL,
  apiKey: process.env.FLOWFORGE_API_KEY,
  name: process.env.WORKER_NAME,
  concurrency: Number(process.env.CONCURRENCY ?? 4),
  pollWaitMs: 2_000,
  drainTimeoutMs: 10_000,
  handleSignals: true,
  logger: {
    info: () => {},
    warn: (m, d) => process.env.E2E_TRACE && console.error(`${new Date().toISOString()} WARN ${m} ${JSON.stringify(d ?? {})}`),
    error: (m, d) => console.error(`${new Date().toISOString()} ERROR ${m} ${JSON.stringify(d ?? {})}`),
  },
  handlers: {
    "e2e.step": async (ctx) => {
      log(ctx, "start");
      await sleep(Number(ctx.input.ms ?? 20), ctx.signal);
      log(ctx, "done");
      return { pid: process.pid };
    },
    "e2e.hang": async (ctx) => {
      log(ctx, "start");
      await sleep(Number(ctx.runInput.hangMs ?? 3_000), ctx.signal);
      log(ctx, "done");
      return { pid: process.pid, attempt: ctx.attempt };
    },
    "e2e.flaky": async (ctx) => {
      log(ctx, "start");
      if (ctx.attempt === 1) throw new Error("transient failure on first attempt");
      log(ctx, "done");
      return { ok: true };
    },
  },
});

await worker.start();
process.stdout.write(`ready ${worker.id}\n`);
