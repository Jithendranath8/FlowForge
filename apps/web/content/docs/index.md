---
title: Introduction
description: What FlowForge is, how its parts fit together, and where to start.
---

FlowForge runs workflows: sets of tasks with dependencies between them, executed by worker processes that you write and run. You describe a workflow as a directed acyclic graph (DAG), start runs of it through the API, and FlowForge decides what can run next, hands each task to a worker, and records everything that happens. If a worker crashes or a task fails, FlowForge retries the work elsewhere without losing or double-recording results.

## The parts

| Part | What it does |
| --- | --- |
| **API** | A stateless HTTP service. It stores workflows, starts runs, resolves dependencies, leases tasks to workers and serves the dashboard's data. Run as many instances as you need. It never executes your code. |
| **PostgreSQL** | The source of truth. Every workflow version, run, task, attempt and event is a row; the API instances coordinate through it. |
| **Redis** | Optional wake-ups, so idle workers hear about new work quickly. If Redis is down, FlowForge keeps working by polling. |
| **Workers** | Your processes, built with the TypeScript SDK. A worker declares the task types it can run and its capacity, long-polls the API for tasks, heartbeats while it works and reports results. |
| **Dashboard** | A web app for people: runs, task executions, workers, scheduling decisions, history and API keys, updated live. Sign-in is with Google or GitHub. |

## How a run proceeds

1. You register a workflow definition. A changed definition becomes a new, immutable version.
2. You start a run, with input and optionally an idempotency key.
3. Tasks whose dependencies are satisfied are queued. A worker that polls receives a lease on a task: the right to run it for a limited time, renewed by heartbeats.
4. The worker runs your handler and reports the output or the error. A completion only counts if it carries the current fencing token, so a worker that lost its lease cannot overwrite newer work.
5. Failed attempts are retried with backoff, up to the task's limit. When every task has reached a final state, the run ends.

Each of these steps is recorded as an event, which the dashboard streams live and the API serves as an audit trail. [Concepts](/docs/concepts) describes the model in detail.

## What it guarantees

Handlers run **at least once**: a task whose worker disappears is run again on another worker, so side effects must tolerate a repeat (the SDK gives each task a stable idempotency key for this). The **recorded result** of a task is written exactly once. [Reliability](/docs/reliability) states the guarantees precisely.

## Where to go next

- [Quick start](/docs/quick-start): run FlowForge locally and execute a workflow in about ten minutes.
- [Workflow definitions](/docs/workflows): every field of a definition.
- [Workers](/docs/workers): writing handlers and running workers.
- [API reference](/docs/api): every endpoint.
- [Operations](/docs/operations) and [Security](/docs/security): running FlowForge for real.

FlowForge is not published to npm yet; you run it from the [source repository](https://github.com/Jithendranath8/FlowForge).
