import { defineWorkflow } from "@flowforge/sdk";

// A DAG: extract runs first, clean and enrich run in parallel, load waits for both.
// notify only runs if extract fails (trigger rule any_failed).
export const dailyReport = defineWorkflow({
  name: "daily-report",
  description: "Extract orders, clean and enrich them in parallel, then load the report.",
  tasks: [
    { key: "extract", type: "orders.extract", retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5_000, backoffCoefficient: 2, jitter: 0.2 } },
    { key: "clean", type: "orders.clean", dependsOn: ["extract"] },
    { key: "enrich", type: "orders.enrich", dependsOn: ["extract"] },
    { key: "load", type: "report.load", dependsOn: ["clean", "enrich"], timeoutMs: 60_000 },
    { key: "notify", type: "report.notify", dependsOn: ["extract"], triggerRule: "any_failed" },
  ],
});
