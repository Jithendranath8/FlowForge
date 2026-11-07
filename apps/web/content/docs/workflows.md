---
title: Workflow definitions
description: The workflow definition format, its defaults and limits, how definitions are validated and versioned, and how trigger rules decide which tasks run.
---

A workflow definition is JSON data that describes a directed acyclic graph (DAG) of tasks. Each task names a task *type*, such as `orders.extract`; your workers register handlers for those types and run them. A definition never contains code, and the API never executes any.

You register a definition once, then start any number of runs of it. Each run gets its own copy of every task, and FlowForge queues each task as soon as its dependencies allow.

## A minimal definition

```json
{
  "name": "daily-report",
  "tasks": [
    { "key": "extract", "type": "orders.extract" },
    { "key": "load", "type": "report.load", "dependsOn": ["extract"] }
  ]
}
```

Every other field has a default. The rest of this page lists them, then covers validation, versioning, retries, timeouts and trigger rules.

## Workflow fields

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `name` | string | required | 1–64 characters matching `^[a-z0-9][a-z0-9_-]{0,63}$`. Identifies the workflow in its tenant |
| `description` | string | none | Up to 2000 characters |
| `tasks` | array of tasks | required | 1–500 tasks |
| `defaults` | object | `{}` | Defaults for the tasks in this workflow: `retry`, `timeoutMs` and `queue`. Same rules as the task fields of those names |
| `maxConcurrency` | integer | 32 | 1–1000. The most tasks of one run that may be running at the same time |

Fields not described on this page, at the workflow or the task level, are dropped when the definition is stored; they do not cause an error.

## Task fields

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `key` | string | required | Unique within the workflow; matches `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `type` | string | required | The handler name a worker registers; matches `^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$` |
| `dependsOn` | array of task keys | `[]` | Up to 64 keys of other tasks in the same workflow |
| `input` | JSON object | `{}` | Static input passed to the handler |
| `queue` | string | `defaults.queue`, else `"default"` | Matches `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `priority` | integer | 0 | −100 to 100. Higher runs first |
| `retry` | object | `defaults.retry`, else the built-in policy | See [Retry policy](#retry-policy) |
| `timeoutMs` | integer | `defaults.timeoutMs`, else 300000 (5 minutes) | 1000 to 86400000 (24 hours), per attempt |
| `triggerRule` | `all_succeeded`, `all_done`, `any_failed` | `all_succeeded` | See [Trigger rules](#trigger-rules) |
| `requiredCapabilities` | array of strings | `[]` | Up to 16, each matching `^[a-z0-9][a-z0-9_.:-]{0,63}$` |
| `resources` | object | `{ "cpu": 1, "memoryMb": 256 }` | `cpu`: number 0–256 (default 1). `memoryMb`: integer 0–1048576 (default 256) |

### How task settings resolve

A task's own value wins, then the workflow's `defaults`, then the built-in default. Two details:

- **`retry` is replaced, not merged.** A task's `retry` object replaces `defaults.retry` entirely, and every retry object must contain all five fields.
- **The queue named `default`.** When `defaults.queue` is set, a task that names no queue goes to `defaults.queue`, and a task that writes `queue: "default"` stays in the queue named `default`.

Repeated entries in `dependsOn` and `requiredCapabilities` are ignored.

### Inputs and outputs

A handler receives three values for each attempt:

| Value | Source |
| --- | --- |
| `input` | The task's `input` from the definition |
| `runInput` | The `input` given when the run was started |
| `checkpoint` | The last checkpoint saved by an earlier attempt of this task, or `null` |

The two inputs are delivered separately; FlowForge does not merge them. A handler's return value is stored as the task's output, which you can read through the API (`GET /v1/runs/{id}` and `GET /v1/tasks/{id}`). Outputs are not passed to dependent tasks: a handler does not receive its dependencies' outputs. If a later task needs data from an earlier one, have the earlier task write it somewhere the later task can read, keyed by run ID.

## Retry policy

A retry policy has five fields, all required whenever you write one:

| Field | Range | Built-in default | Meaning |
| --- | --- | --- | --- |
| `maxAttempts` | 1–25 | 3 | Total attempts, including the first. `1` means no retries |
| `initialDelayMs` | 0–21600000 | 1000 | Delay before the first retry |
| `maxDelayMs` | 0–21600000, and ≥ `initialDelayMs` | 60000 | Upper bound on any delay |
| `backoffCoefficient` | 1–10 | 2 | Multiplier applied per further retry |
| `jitter` | 0–1 | 0.2 | Fraction of each delay that is randomised |

The delay after the *n*th failed attempt is `min(maxDelayMs, initialDelayMs × backoffCoefficient^(n−1))`, reduced by a random amount of up to `jitter` times itself. Jitter only shortens a delay, so it never exceeds `maxDelayMs`. With the built-in policy, the first retry waits 800–1000 ms, the second 1600–2000 ms, and the third failure is final. While it waits, the task is in state `retry_scheduled`; the API's maintenance loop (every `MAINTENANCE_INTERVAL_MS`, default 1000) moves it back to `queued` once the delay has passed.

These failures use up an attempt and are retried while attempts remain:

- The handler throws, or the worker reports a failure.
- The attempt exceeds `timeoutMs`.
- The worker stops heartbeating (it crashed, was cut off, or shut down while running the task), and the lease expires.

A failure reported as not retryable (in the SDK, throwing `NonRetryableError`) fails the task at once, whatever attempts remain. When a task fails for good it moves to `failed` and a dead letter is recorded. You can retry it by hand with `POST /v1/tasks/{id}/retry`, which grants a fresh set of attempts (see the [API reference](/docs/api#retry-a-failed-task)).

## Timeouts

`timeoutMs` limits each attempt, measured from the moment a worker leases the task. Heartbeats renew the lease but never past this deadline, so a handler that hangs while its worker keeps heartbeating still times out. At the deadline the SDK aborts the handler's `signal`. The lease ends at the deadline too, so the API fails the attempt itself as timed out (outcome `timed_out`). A timed-out attempt is retried like any other failure.

## Placement: queues, priority, capabilities and resources

A worker receives a queued task only if all of these hold:

- the worker listens on the task's `queue`;
- it has a handler for the task's `type`;
- it has every capability in `requiredCapabilities`;
- the free CPU and memory it reports cover the task's `resources`;
- the run has fewer than `maxConcurrency` tasks running, and the tenant is under its `max_concurrency` quota (default 256 running tasks).

A task that no worker can take stays `queued`; it does not fail. Among tasks a worker can take, higher `priority` goes first, and equal priorities go in the order the tasks were queued. The run's priority (set when the run is started, −100 to 100) is added to every task's priority, and a queued task gains 1 point for every 30 seconds it has waited, up to 50 points, so low-priority work is not starved. When tasks of several runs have the same effective priority, the run with fewer tasks running goes first, so one large run cannot crowd out the others.

## Trigger rules

A task's trigger rule decides what happens once all of its direct dependencies have finished. Until then the task stays `pending`. A dependency has finished when it is `succeeded`, `failed`, `skipped` or `cancelled`; a dependency waiting to be retried (`retry_scheduled`) has not, so its dependents wait for the retry. `failed` means the dependency used up its retries or failed with a non-retryable error.

| Rule | The task is queued when | The task is skipped when |
| --- | --- | --- |
| `all_succeeded` (default) | every dependency succeeded | any dependency failed, was skipped or was cancelled |
| `all_done` | no dependency was cancelled | any dependency was cancelled |
| `any_failed` | at least one dependency failed | no dependency failed (they all succeeded or were skipped) |

The rules look only at direct dependencies and their final states:

- **Skipped is not failed.** For `any_failed`, a dependency that was skipped does not count, even if it was skipped because something further upstream failed. To react to a failure anywhere in a chain, list every task you want to watch in `dependsOn`.
- **Tasks with no dependencies.** A task with an empty `dependsOn` is evaluated when the run starts. Under `all_succeeded` and `all_done` it is queued at once; under `any_failed` it is skipped at once, because no dependency can fail.
- **Skips cascade.** A skipped task counts as finished, so its own dependents are evaluated immediately, in the same transaction: `all_succeeded` dependents are skipped too, `all_done` dependents are queued, and `any_failed` dependents are skipped unless another of their dependencies failed.
- **Cancellation.** Tasks are cancelled only when their whole run is cancelled, which cancels every unfinished task at once, so in practice no task is left waiting on a cancelled dependency.

### How a run ends

A run finishes when every one of its tasks has finished. Its outcome is:

1. `cancelled` if the run was cancelled;
2. otherwise `failed` if any task failed;
3. otherwise `succeeded`. Skipped tasks do not fail a run.

A failure does not stop the rest of the run. Branches that do not depend on the failed task keep running, and the run's outcome is set only when the last task finishes. A run in which an `any_failed` task handled a failure still ends `failed`, because the original task failed.

Retrying a failed task by hand (`POST /v1/tasks/{id}/retry`) returns a `failed` run to `running`, re-queues the task, and reopens the skipped tasks that depend on it, directly or through other skipped tasks, so trigger rules are evaluated again when the task finishes. Tasks that already ran are not run again.

## Validation errors

The API validates a definition when you register it and stores it only if it is valid. The SDK's `defineWorkflow` runs the same checks locally and throws an `Error` listing every problem.

| Code | Meaning |
| --- | --- |
| `schema` | A field is missing, has the wrong type, or is out of range. `path` names the field, for example `tasks.0.timeoutMs` |
| `duplicate_key` | Two tasks share a `key` |
| `self_dependency` | A task lists its own key in `dependsOn` |
| `unknown_dependency` | `dependsOn` names a key that is not a task in this workflow |
| `cycle` | The dependencies form a cycle. `path` lists the cycle, starting and ending with the same key |

If any field fails the schema checks, only those problems are reported. Otherwise duplicate keys, self-dependencies and unknown dependencies are reported together, and cycles are checked only when there are none of those. The API answers `422 invalid_workflow` with every issue in `details.issues`; each has a `code`, a human-readable `message`, and the fields above:

```json
{
  "error": {
    "code": "invalid_workflow",
    "message": "Workflow definition is invalid",
    "details": {
      "issues": [
        { "code": "unknown_dependency", "key": "load", "dependency": "clean", "message": "Task \"load\" depends on unknown task \"clean\"" },
        { "code": "cycle", "path": ["a", "c", "b", "a"], "message": "Dependency cycle: a -> c -> b -> a" }
      ]
    },
    "requestId": "6f1c2b9a-3d4e-4f50-8a61-7b2c3d4e5f60"
  }
}
```

The two issues above come from different definitions; a single response never contains both a cycle and another dependency issue.

### Limits

| Limit | Value |
| --- | --- |
| Tasks per workflow | 500 |
| Dependencies per task | 64 |
| Required capabilities per task | 16 |
| Retry attempts | 25 |
| Retry delay | 6 hours (21600000 ms) |
| Attempt timeout | 1 second to 24 hours |
| Priority | −100 to 100 |
| Tasks of one run running at once | `maxConcurrency`, 1 to 1000 |
| Definition size | `DEFINITION_MAX_BYTES` (default 262144 bytes, 256 KiB), measured on the stored form with defaults filled in. Larger definitions get `413 definition_too_large` |
| Request body | `MAX_PAYLOAD_BYTES` (default 1048576 bytes, 1 MiB) |
| Workflows per tenant | `max_workflows` quota (default 200) |
| Versions per workflow | `max_versions_per_workflow` quota (default 200) |

The size limits are API settings and the last two are tenant quotas; see [Operations](/docs/operations) and the [API reference](/docs/api#tenant-quotas).

## Versioning

Every registration is checked against the workflow's stored versions:

- **A changed definition creates a new version.** Versions are numbered 1, 2, 3 and so on per workflow, and are immutable: they are never edited or deleted. The response is `201 Created` with `"created": true`.
- **An identical definition creates nothing.** If the definition matches any stored version of the workflow, the API returns that version with `200 OK` and `"created": false`. You can register on every deploy without creating versions.

Definitions are compared after unknown fields are dropped and schema defaults are filled in, with object keys in sorted order. So writing out `dependsOn: []`, `queue: "default"` (when there is no `defaults.queue`), `priority: 0`, `triggerRule: "all_succeeded"`, `requiredCapabilities: []`, `defaults: {}` or `maxConcurrency: 32` does not make a definition different. Adding `retry`, `timeoutMs`, `resources` or `input` does, even with the default values, as do changing the description, reordering `tasks`, or reordering a `dependsOn` list.

New runs use the latest version unless the request names a `version`. Re-registering an older definition returns its old version number and does not make it the latest again. A run keeps the version it started with: registering a new version never changes runs that are already in progress.

## Registering a definition

### With the SDK

```ts
import { FlowForgeClient, defineWorkflow } from "@flowforge/sdk";

const dailyReport = defineWorkflow({
  name: "daily-report",
  tasks: [
    { key: "extract", type: "orders.extract" },
    { key: "load", type: "report.load", dependsOn: ["extract"] },
  ],
});

const client = new FlowForgeClient({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
});

const { version, created } = await client.registerWorkflow(dailyReport);
console.log(`daily-report version ${version}${created ? " (new)" : ""}`);
```

`defineWorkflow` validates the definition and returns it unchanged, so mistakes surface before any request is sent. `registerWorkflow` needs a key with the `workflows:write` scope and resolves to `{ workflowId, versionId, version, created }`.

### With curl

Save the definition as `daily-report.json` and send it as the body of `PUT /v1/workflows`:

```sh
curl -X PUT "$FLOWFORGE_API_URL/v1/workflows" \
  -H "Authorization: Bearer $FLOWFORGE_API_KEY" \
  -H "Content-Type: application/json" \
  --data @daily-report.json
```

```json
{
  "workflowId": "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  "versionId": "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  "version": 1,
  "created": true
}
```

## Worked example

This is the workflow from the [quick start](/docs/quick-start). `extract` runs first. `clean` and `enrich` depend on it and can run in parallel. `load` waits for both. `notify` depends on `extract` with `any_failed`, so it runs only if `extract` fails for good.

```ts
import { defineWorkflow } from "@flowforge/sdk";

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
```

Every task not shown with its own setting uses the built-in defaults: queue `default`, priority 0, a 5-minute timeout, and 3 attempts with backoff from 1 second. `extract` gets a faster retry policy (retries after about 0.5 and 1 second) and `load` a 1-minute timeout. The run is limited to 32 running tasks, the default `maxConcurrency`.

Register it and start a run:

```ts
import { FlowForgeClient } from "@flowforge/sdk";
import { dailyReport } from "./workflow.js";

const client = new FlowForgeClient({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
});

const { version } = await client.registerWorkflow(dailyReport);
const run = await client.startRun("daily-report", {
  input: { day: "2026-11-01" },
  idempotencyKey: "daily-report:2026-11-01",
});
const { run: done, tasks } = await client.waitForRun(run.id, { timeoutMs: 60_000 });
console.log(`version ${version}: run ${done.state}`);
for (const t of tasks) console.log(`${t.key} ${t.state} attempts=${t.attempts}`);
```

This needs a key with `workflows:write`, `runs:write` and `read`. A worker with handlers for the five task types must be running; see [Workers](/docs/workers).

How the run ends depends on which tasks fail:

| What happens | `extract` | `clean` | `enrich` | `load` | `notify` | Run |
| --- | --- | --- | --- | --- | --- | --- |
| Everything succeeds | succeeded | succeeded | succeeded | succeeded | skipped | `succeeded` |
| `extract` fails all 3 attempts | failed | skipped | skipped | skipped | succeeded | `failed` |
| `clean` fails for good | succeeded | failed | succeeded | skipped | skipped | `failed` |

In the second case, `clean` and `enrich` are skipped because their dependency failed, and `load` is skipped because its dependencies were skipped. `notify` runs because a direct dependency failed. In the third case, `notify` was already skipped when `extract` succeeded, so nothing reacts to the failure of `clean`. To alert on a failure of any task, give the alerting task every task you care about in `dependsOn`:

```ts
{ key: "notify", type: "report.notify", dependsOn: ["extract", "clean", "enrich", "load"], triggerRule: "any_failed" }
```

It then waits until all four have finished and runs if any of them failed. A skipped `load` does not count, but the failure that caused the skip does, because that task is listed too.

The same definition as JSON, for `curl` or any other HTTP client:

```json
{
  "name": "daily-report",
  "description": "Extract orders, clean and enrich them in parallel, then load the report.",
  "tasks": [
    {
      "key": "extract",
      "type": "orders.extract",
      "retry": { "maxAttempts": 3, "initialDelayMs": 500, "maxDelayMs": 5000, "backoffCoefficient": 2, "jitter": 0.2 }
    },
    { "key": "clean", "type": "orders.clean", "dependsOn": ["extract"] },
    { "key": "enrich", "type": "orders.enrich", "dependsOn": ["extract"] },
    { "key": "load", "type": "report.load", "dependsOn": ["clean", "enrich"], "timeoutMs": 60000 },
    { "key": "notify", "type": "report.notify", "dependsOn": ["extract"], "triggerRule": "any_failed" }
  ]
}
```

## A definition using every field

```json
{
  "name": "invoice-sync",
  "description": "Pull invoices, convert currencies, push them to the ledger.",
  "maxConcurrency": 8,
  "defaults": {
    "queue": "billing",
    "timeoutMs": 120000,
    "retry": { "maxAttempts": 5, "initialDelayMs": 2000, "maxDelayMs": 60000, "backoffCoefficient": 2, "jitter": 0.2 }
  },
  "tasks": [
    { "key": "fetch", "type": "invoices.fetch", "input": { "source": "stripe" } },
    {
      "key": "convert",
      "type": "fx.convert",
      "dependsOn": ["fetch"],
      "priority": 10,
      "requiredCapabilities": ["fx-rates"],
      "resources": { "cpu": 2, "memoryMb": 1024 }
    },
    {
      "key": "push",
      "type": "ledger.push",
      "dependsOn": ["convert"],
      "timeoutMs": 30000,
      "retry": { "maxAttempts": 1, "initialDelayMs": 0, "maxDelayMs": 0, "backoffCoefficient": 1, "jitter": 0 }
    },
    { "key": "report", "type": "ops.report", "dependsOn": ["push"], "triggerRule": "all_done", "queue": "ops" },
    { "key": "page", "type": "ops.page", "dependsOn": ["fetch", "convert", "push"], "triggerRule": "any_failed", "queue": "ops" }
  ]
}
```

- `fetch`, `convert` and `push` run on the `billing` queue, and `fetch` and `convert` get 5 attempts and a 2-minute timeout, from `defaults`.
- `convert` goes only to a worker that advertises the `fx-rates` capability and has 2 CPUs and 1024 MB free.
- `push` gets one attempt and 30 seconds.
- `report` runs on the `ops` queue after `push` finishes, whether `push` succeeded, failed or was skipped.
- `page` runs if any of `fetch`, `convert` or `push` failed. If `fetch` fails, `convert` and `push` are skipped and `page` still runs, because `fetch` is a direct dependency.
