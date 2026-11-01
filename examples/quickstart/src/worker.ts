import { createWorker, NonRetryableError } from "@flowforge/sdk";

const worker = createWorker({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
  concurrency: 4,
  handleSignals: true, // SIGTERM/SIGINT: finish in-flight tasks, then deregister
  handlers: {
    "orders.extract": async ({ runInput }) => {
      const day = String(runInput.day ?? new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new NonRetryableError(`invalid day "${day}"`);
      // Deterministic sample data so the example runs without external services.
      return { day, orders: [{ id: 1, total: 42.5 }, { id: 2, total: 17.25 }, { id: 3, total: 99 }] };
    },
    "orders.clean": async () => ({ dropped: 0 }),
    "orders.enrich": async () => ({ currency: "USD" }),
    "report.load": async ({ runId, idempotencyKey }) => {
      // Use idempotencyKey when writing to external systems: tasks are delivered at least once.
      return { reportId: idempotencyKey, runId };
    },
    "report.notify": async ({ runId }) => {
      console.warn(`extract failed for run ${runId}`);
      return { notified: true };
    },
  },
});

await worker.start();
console.warn(`worker ${worker.id} polling for tasks (Ctrl+C to stop)`);
