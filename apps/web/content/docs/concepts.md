---
title: Concepts
description: The FlowForge model (workspaces, workflows, versions, runs, tasks, attempts, workers, queues and events), the task and run state machines, and how a run progresses.
---

FlowForge executes workflows: directed acyclic graphs (DAGs) of tasks. You register a workflow definition, which is pure data that names task types but contains no code. You start runs of it, and you run worker processes that implement the task types. The API stores all state in PostgreSQL, decides which tasks are runnable, and leases them to workers. It never executes your code. This page defines the terms, lists the states a task and a run can be in, and follows one run from submission to completion.

## Terms

| Term | Meaning |
| --- | --- |
| Workspace | The isolation boundary. Workflows, runs, workers, API keys and quotas belong to one workspace, and every request acts within the workspace of its credential. The API and database call it a tenant. |
| Workflow | A named DAG definition: a list of tasks with their dependencies, defaults for retries, timeouts and queue, and a per-run concurrency limit (`maxConcurrency`, default 32). See [Workflow definitions](/docs/workflows). |
| Workflow version | Registering a definition stores it as an immutable, numbered version. Registering a definition identical to an existing version returns that version instead of creating a new one. Versions are never deleted. |
| Run | One execution of one workflow version with a JSON input. A run uses the latest version at submission unless you ask for a specific `version`. Starting a run with an idempotency key already used for that workflow returns the original run. |
| Task | One node of the DAG inside a run, identified by its `key` (for example `extract`). It carries a type, a queue, a priority, a retry policy, a timeout, a trigger rule, resource requests and required capabilities, all copied from the version when the run is created. |
| Task type | The handler name a task refers to, such as `orders.extract`. A task runs only on a worker that registered a handler for its type. |
| Attempt | One lease of a task to a worker. Attempts are numbered from 1, each records its worker and fencing token, and each ends with one outcome: `succeeded`, `failed`, `timed_out`, `lease_expired` or `cancelled`. |
| Lease | Time-limited ownership of a running task by one worker. Worker heartbeats renew it; if it expires, the attempt fails and the task can be retried elsewhere. See [Reliability](/docs/reliability). |
| Fencing token | A counter on each task (`fence`) that increases every time the task is leased. Heartbeats, checkpoints and results must present the current value, so a worker whose lease was taken over cannot record anything. |
| Worker | A process running the TypeScript SDK. It registers the task types, queues and capacity it offers, long-polls the API for tasks, runs handlers, heartbeats and reports results. Its state is `active`, `draining` or `offline`. See [Workers](/docs/workers). |
| Queue | A routing label on a task (default `default`). A worker lists the queues it serves and receives tasks only from those. A queue is a column on the task row plus a wake-up channel, not separate infrastructure. |
| Capability | A label a task can require, such as `gpu`. Only workers that advertise every required capability receive the task. |
| Trigger rule | Decides, once all of a task's dependencies have finished, whether the task runs or is skipped: `all_succeeded` (default), `all_done` or `any_failed`. |
| Checkpoint | JSON progress a handler saves during an attempt. The next attempt of the same task receives it. |
| Dead letter | A record created when a task fails for good: a non-retryable error, or its last allowed attempt failed. Retrying the task manually resolves it. |
| Event | An append-only history record of a state change, such as `task.started`. A run or task state change writes its event in the same database transaction. |

### Workspace quotas

Each workspace has quotas, enforced under a lock on the workspace row so concurrent requests cannot overshoot them. Operators change them with `flowforge-admin set-quota`.

| Quota | Default | At the limit |
| --- | --- | --- |
| Running tasks (`max_concurrency`) | 256 | Further tasks stay queued until running tasks finish |
| Runs in state `running` (`max_active_runs`) | 500 | Starting a run returns `429 quota_exceeded` |
| Workflows (`max_workflows`) | 200 | Registering a new workflow name returns `429 quota_exceeded` |
| Versions per workflow (`max_versions_per_workflow`) | 200 | Registering a new version returns `429 quota_exceeded` |
| Workers not offline (`max_active_workers`) | 100 | Registering a worker returns `429 quota_exceeded` |

A repeated run idempotency key returns the original run even when the workspace is at its run quota.

## Task states

| State | Meaning | Terminal |
| --- | --- | --- |
| `pending` | Waiting for its dependencies to finish. | No |
| `queued` | Runnable, waiting for a worker to claim it. | No |
| `running` | Leased to a worker. | No |
| `retry_scheduled` | An attempt failed and another is allowed; waiting for the backoff delay to pass. | No |
| `succeeded` | A worker's completion was accepted. | Yes |
| `failed` | A non-retryable error, or the last allowed attempt failed. A dead letter is recorded. | Yes, unless retried manually |
| `skipped` | The trigger rule can no longer be satisfied. | Yes, unless re-opened by a manual retry upstream |
| `cancelled` | The run was cancelled before the task finished. | Yes |

Dependency resolution treats every terminal state as finished.

### Task transitions

Every task state change is checked against this table (`assertTaskTransition`). Any other transition is rejected.

| From | To | Cause | Event |
| --- | --- | --- | --- |
| `pending` | `queued` | Every dependency is terminal and the trigger rule is satisfied. Tasks with no dependencies are evaluated when the run is created. | `task.queued` |
| `pending` | `skipped` | Every dependency is terminal and the trigger rule is not satisfied. Skips cascade to downstream tasks in the same transaction. | `task.skipped` |
| `pending` | `cancelled` | The run was cancelled. | `task.cancelled` |
| `queued` | `running` | A worker claimed the task. The fence and the attempt counter increase and a lease is granted. | `task.started` |
| `queued` | `cancelled` | The run was cancelled. | `task.cancelled` |
| `running` | `succeeded` | The lease holder reported completion and passed the fencing check. | `task.succeeded` |
| `running` | `retry_scheduled` | The attempt failed (handler error, timeout, lease expiry or worker shutdown) and the retry policy allows another attempt. | `task.retry_scheduled` |
| `running` | `failed` | The handler threw a `NonRetryableError`, or this was the last allowed attempt. | `task.failed` |
| `running` | `cancelled` | The run was cancelled. The worker learns this at its next heartbeat. | `task.cancelled` |
| `retry_scheduled` | `queued` | The backoff delay elapsed; the maintenance loop re-queues the task. | `task.queued` |
| `retry_scheduled` | `cancelled` | The run was cancelled. | `task.cancelled` |
| `failed` | `queued` | Manual retry (`POST /v1/tasks/{id}/retry`), with a fresh retry budget. | `task.queued` |
| `skipped` | `pending` | A manual retry of the failed upstream task re-opens the tasks it caused to be skipped. | `task.reopened` |

`succeeded` and `cancelled` have no outgoing transitions.

### Trigger rules

A trigger rule is evaluated when every dependency of a `pending` task has reached a terminal state.

| Rule | The task runs if | Otherwise |
| --- | --- | --- |
| `all_succeeded` (default) | every dependency succeeded | skipped |
| `all_done` | no dependency was cancelled (succeeded, failed and skipped all count) | skipped |
| `any_failed` | at least one dependency failed | skipped |

A task with no dependencies is evaluated when the run is created: under `all_succeeded` or `all_done` it is queued at once, and under `any_failed` it is skipped, because no dependency can fail. Use `any_failed` for alerting or compensation tasks and `all_done` for cleanup that must run whatever happened upstream.

## Run states

| State | Meaning | Can move to |
| --- | --- | --- |
| `running` | The run exists and at least one task is not terminal. Runs are created in this state. | `succeeded`, `failed`, `cancelled` |
| `succeeded` | Every task succeeded or was skipped. | none |
| `failed` | Every task is terminal and at least one failed. | `running`, when a failed task is retried manually |
| `cancelled` | The run was cancelled through the API. | none |

The engine derives the outcome from the task states. While any task is not terminal, the run stays `running`. When all are terminal, the run is `cancelled` if any task was cancelled, otherwise `failed` if any task failed, otherwise `succeeded`. A failure that an `any_failed` task handled still fails the run, because the failed task stays `failed`.

Independent branches keep running after a task fails: only the failed task's dependants are affected, through their trigger rules. There is no run-level timeout; each task has its own.

## How tasks are scheduled

Workers ask for work by long-polling the API, reporting how many free slots, CPU and memory they have. The API then leases queued tasks to the worker.

A task is eligible for a worker only if all of these hold:

- its queue is one the worker serves;
- the worker has a handler for its type;
- the worker advertises every capability the task requires;
- it fits the worker's free slots, CPU and memory (each task requests 1 CPU and 256 MB unless its definition says otherwise);
- its run has fewer running tasks than the workflow's `maxConcurrency` (default 32);
- the workspace has fewer running tasks than its `max_concurrency` quota (default 256).

Eligible tasks are ordered by an effective score: the task's priority, plus the run's priority given at submission, plus an aging bonus of 1 for every 30 seconds the task has been queued (at most 50). Each pick takes the highest-scoring task across runs. When two runs' best tasks score the same, the run with fewer running tasks goes first, so one large run cannot starve the others. Within a run, tasks with equal scores go in the order they were queued. Each claim considers at most 200 queued tasks from the worker's queues and task types: the 150 with the highest priority (then oldest first) and the 50 that have waited longest, so the longest-waiting tasks are considered even while 150 or more higher-priority tasks are queued.

The scheduling policy can accept an advisory score adjustment, bounded to ±10, that can never make an ineligible task eligible. The API does not currently install an advisor, so ordering is deterministic.

Claiming a task is a guarded update of a row in state `queued` under the run's row lock, so two workers can never lease the same task at the same time.

## Events

The engine records an event for every state change, plus an outbox row that is later relayed to Redis to wake idle workers and update live views. For run and task state changes both are written in the same transaction as the change: if it rolls back, neither exists.

| Group | Event types |
| --- | --- |
| Run | `run.created`, `run.succeeded`, `run.failed`, `run.cancelled`, `run.reopened` |
| Task | `task.queued`, `task.started`, `task.succeeded`, `task.retry_scheduled`, `task.failed`, `task.skipped`, `task.cancelled`, `task.reopened`, `task.checkpointed` |
| Worker | `worker.registered`, `worker.offline`, `worker.deregistered` |

Read a run's history with `GET /v1/runs/{id}/events`, or follow events live with `GET /v1/stream` (Server-Sent Events). The [API reference](/docs/api#events) lists each event's `data` fields.

## A run from start to finish

This walk-through uses the `daily-report` workflow from the [quick start](/docs/quick-start): `extract` runs first, `clean` and `enrich` depend on it, `load` depends on both, and `notify` depends on `extract` with the trigger rule `any_failed`.

```ts
const run = await client.startRun("daily-report", {
  input: { day: "2026-11-01" },
  idempotencyKey: "daily-report:2026-11-01",
});
```

1. **Submission.** In one transaction the API creates the run in state `running` and five tasks in state `pending`, and records `run.created`. Dependency resolution runs at once: `extract` has no dependencies, so it moves to `queued` (`task.queued`). The other four stay `pending`.
2. **Wake-up.** The outbox relay publishes the `task.queued` event to Redis (every 100 ms by default), which wakes workers long-polling the `default` queue. Without Redis, a waiting poll re-checks the database every second.
3. **Claim.** A worker with an `orders.extract` handler claims `extract`. The task moves to `running` with fence 1 and attempt 1, a 30-second lease (the default), and an attempt deadline of claim time plus the task's timeout (5 minutes by default). The API records `task.started`.
4. **Completion.** The handler returns. The SDK reports the output with the fence it was given. The fencing check passes, so `extract` moves to `succeeded` (`task.succeeded`). In the same transaction dependency resolution queues `clean` and `enrich` (`task.queued` twice) and skips `notify`, whose `any_failed` rule cannot be met (`task.skipped`).
5. **Parallel tasks.** `clean` and `enrich` are claimed, by one worker or two, and run at the same time (`task.started`, `task.succeeded` for each). When the second one succeeds, `load` is queued.
6. **Last task.** `load` runs and succeeds. Every task is now terminal: four succeeded and one skipped. The run moves to `succeeded` and the API records `run.succeeded` with the run's duration.

If `extract` instead throws an ordinary error, the attempt fails and the task moves to `retry_scheduled` (`task.retry_scheduled`, with the backoff delay). When the delay has passed it returns to `queued` (`task.queued` with `retryOfAttempt`) and is claimed again as attempt 2. The quick start's `extract` allows 3 attempts. If the third also fails, or if the handler throws a `NonRetryableError`, `extract` moves to `failed` (`task.failed`) and a dead letter is recorded. Resolution then skips `clean` and `enrich`, then `load` (whose dependencies were skipped), and queues `notify`. Once `notify` finishes, the run ends `failed`.

A manual retry of `extract` (`POST /v1/tasks/{id}/retry`) gives it a fresh retry budget and moves it back to `queued`. It re-opens `clean`, `enrich` and `load` to `pending` (`task.reopened`) and moves the run back to `running` (`run.reopened`).
