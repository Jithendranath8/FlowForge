---
title: Quick start
description: Run FlowForge on your machine and execute a five-task workflow from start to finish.
---

You need Node.js 22 or later and Docker. Everything runs locally: PostgreSQL and Redis in containers, the API and a worker as Node.js processes. Allow about ten minutes.

<!-- install-steps -->

## What you just ran

The workflow is a small DAG. `extract` runs first; `clean` and `enrich` depend on it and run in parallel; `load` waits for both. `notify` depends on `extract` with the trigger rule `any_failed`, so it only runs if `extract` fails.

<!-- include examples/quickstart/src/workflow.ts ts -->

The worker registers the handlers for those task types and long-polls the API for work. Each handler receives the task's input and the run's input, and returns its output.

<!-- include examples/quickstart/src/worker.ts ts -->

The script registers the workflow (a new version only if the definition changed), starts a run with an idempotency key, and waits for the run to finish.

<!-- include examples/quickstart/src/run.ts ts -->

Because `extract` succeeds, `notify`'s trigger rule does not match and it ends as skipped; the run succeeds. Run the script again and you get the same run back: the idempotency key `daily-report:2026-11-01` makes the submission idempotent.

## See it fail and recover

- Stop the worker with Ctrl+C while a run is in progress. It stops taking work, finishes the tasks it is running, then deregisters; anything still unfinished is released at once and retried under its retry policy.
- To see a crash instead, kill the worker with `kill -9 <pid>`. It cannot say goodbye, so its tasks are re-leased only when their lease expires, each with a new fencing token; start the worker again to pick them up.
- Start two workers in separate terminals. Tasks are spread across them; `clean` and `enrich` can run at the same time on different workers.
- Open the dashboard (`npm run dev -w @flowforge/web`, then http://localhost:3000) to watch runs, attempts and workers update live. Signing in needs a Google or GitHub OAuth client and your email address in `AUTH_ALLOWED_EMAILS`; see [Security](/docs/security).

## Next

- [Concepts](/docs/concepts): runs, tasks, attempts, leases and states.
- [Workers](/docs/workers): every worker option and what the handler context contains.
- [Workflow definitions](/docs/workflows): retries, timeouts, queues, priorities and trigger rules.
