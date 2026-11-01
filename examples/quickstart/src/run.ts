import { FlowForgeClient } from "@flowforge/sdk";
import { dailyReport } from "./workflow.js";

const client = new FlowForgeClient({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
});

const { version } = await client.registerWorkflow(dailyReport);
const run = await client.startRun("daily-report", {
  input: { day: "2026-11-01" },
  idempotencyKey: "daily-report:2026-11-01", // re-running this script returns the same run
});
console.warn(`started run ${run.id} (workflow version ${version})`);

const { run: done, tasks } = await client.waitForRun(run.id, { timeoutMs: 60_000 });
console.warn(`run ${done.state}`);
for (const t of tasks) console.warn(`  ${t.key.padEnd(8)} ${t.state.padEnd(10)} attempts=${t.attempts}`);
