---
title: Workers
description: Write and run task handlers with the TypeScript SDK, including every worker option and default, the handler context, errors, checkpoints, cancellation, timeouts, heartbeats, capacity, shutdown and idempotency.
---

A worker is a Node.js process that you write and run. It registers the task types it can handle with the API, long-polls for tasks, runs your handler for each one, heartbeats while handlers run, and reports each result. Workers talk to the API over HTTP only, so they need an API key but no database or Redis credentials. This page covers the `Worker` class in the TypeScript SDK.

## Install and import

The SDK is the `@flowforge/sdk` package: ES modules only, Node.js 20.3 or later. In this repository it is a workspace package. Depend on it from your own workspace package, as `examples/quickstart` does, then run `npm install` and `npm run build` at the repository root, because the package exports its built `dist/` files.

```json
{
  "dependencies": { "@flowforge/sdk": "1.0.0" }
}
```

```ts
import { createWorker, NonRetryableError, FlowForgeError, type TaskContext } from "@flowforge/sdk";
```

The worker needs an API key with the `worker` scope. That scope covers the worker protocol and nothing else; see [API keys and scopes](/docs/api#scopes).

## A minimal worker

```ts
import { createWorker, NonRetryableError } from "@flowforge/sdk";

const worker = createWorker({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
  handleSignals: true, // SIGTERM/SIGINT: finish in-flight tasks, then deregister
  handlers: {
    "orders.extract": async ({ runInput }) => {
      const day = String(runInput.day ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new NonRetryableError(`invalid day "${day}"`);
      return { day, orders: [] };
    },
  },
});

await worker.start();
console.log(`worker ${worker.id} polling for tasks`);
```

`createWorker(options)` is the same as `new Worker(options)`. The constructor throws if `handlers` is empty, or if `apiUrl` or `apiKey` is missing.

`start()` registers the worker, starts the heartbeat timer and the poll loop, and resolves once registration has succeeded. Registration is retried with exponential backoff (1 second, doubling to at most 15 seconds) on network errors, `5xx` responses and `429` responses. That includes `429 quota_exceeded`, so a worker started while the workspace is at its worker quota keeps retrying until the workspace is back under its quota. Any other error, such as an invalid key, a missing scope or an invalid option, rejects `start()`. Calling `start()` a second time throws, even while the first call is still registering.

Two read-only properties help with logging and health checks: `worker.id` is the registered worker ID (`null` before `start()`), and `worker.runningTasks` is the number of handlers in flight.

## Worker options

| Option | Default | Description |
| --- | --- | --- |
| `apiUrl` | required | Base URL of the API, for example `http://localhost:4000`. |
| `apiKey` | required | API key with the `worker` scope. Sent as a bearer token. |
| `handlers` | required | Map of task type to handler function. At least one. The keys are the task types the worker registers, and it is offered only tasks of those types. |
| `name` | `<hostname>-<pid>` | Display name in the dashboard and API (1–100 characters). |
| `queues` | `["default"]` | Queues this worker takes tasks from (1–32 names). |
| `capabilities` | `[]` | Capabilities this worker advertises (up to 32), such as `gpu`. |
| `concurrency` | `4` | Maximum tasks this worker runs at once: its slots (1–256). |
| `cpu` | same as `concurrency` | CPU units advertised to the scheduler (0.1–1024). |
| `memoryMb` | `1024 × concurrency` | Memory in MB advertised to the scheduler (16–4,194,304). |
| `pollWaitMs` | `20000` | How long one long-poll waits for work. Values above 20,000 are clamped to 20,000. |
| `drainTimeoutMs` | `30000` | On `stop()`, how long in-flight tasks may keep running before they are aborted. |
| `handleSignals` | `false` | Call `stop()` on the first `SIGTERM` or `SIGINT`. |
| `logger` | `warn` and `error` to the console, `info` dropped | An object with `info`, `warn` and `error` methods, each called as `(message, data?)`. |
| `timeoutMs` | `30000` | Timeout for each HTTP request. A poll request uses its wait plus 15,000 ms instead. |
| `userAgent` | `flowforge-sdk/1.0.0` | `User-Agent` header on every request. |

Lowering `pollWaitMs` does not make pickup faster: the API answers a poll as soon as a task is available. A lower value only adds requests while the worker is idle.

Three timings are not worker options. The API sets them for every worker:

| Setting (API environment) | Default | Effect on the worker |
| --- | --- | --- |
| `WORKER_HEARTBEAT_INTERVAL_MS` | 10,000 ms | How often the worker heartbeats. The API returns it at registration. |
| `LEASE_DURATION_MS` | 30,000 ms | How long each lease lasts after a claim or heartbeat. |
| `WORKER_OFFLINE_AFTER_MS` | 60,000 ms | How long the worker can be silent before the API marks it offline. |

Task timeouts come from the workflow definition (`timeoutMs`, 5 minutes by default).

## The handler context

A handler is a function `(ctx: TaskContext) => unknown | Promise<unknown>`. The context contains:

| Field | Type | Description |
| --- | --- | --- |
| `taskId` | `string` | The task's ID. |
| `runId` | `string` | The run's ID. |
| `key` | `string` | The task's key in the workflow, such as `extract`. |
| `type` | `string` | The task type: the handler name. |
| `attempt` | `number` | 1-based attempt number. Above 1 for automatic retries, for re-deliveries after a lost lease, and after a manual retry (the count continues). |
| `input` | `Record<string, unknown>` | The static `input` from the task definition, or `{}`. |
| `runInput` | `Record<string, unknown>` | The input the run was started with. |
| `checkpoint` | `unknown` | The last checkpoint saved by an earlier attempt of this task, or `null`. |
| `idempotencyKey` | `string` | `<runId>:<taskKey>`. The same for every attempt of this task in this run. |
| `signal` | `AbortSignal` | Aborted when the run is cancelled, the lease is lost, the attempt times out, or the worker shuts down. |
| `traceparent` | `string \| null` | W3C `traceparent` of the run's trace, or `null` when the API does not trace. |
| `saveCheckpoint(data)` | `(data: unknown) => Promise<void>` | Saves progress for later attempts. See [Checkpoints](#checkpoints-and-resuming). |

`input` and `runInput` are delivered separately. The SDK does not merge them.

The context does not contain upstream tasks' outputs. A handler that needs one can read the run through `FlowForgeClient.getRun(ctx.runId)` with a key that has the `read` scope. That call returns outputs up to 16 KiB inline; a larger output comes back as `null` with `outputTruncated: true`, and `GET /v1/tasks/{id}` returns it in full.

## Returning output

The handler's return value becomes the task's output. `undefined` is stored as `null`. The value must be JSON-serialisable, and the completion request that carries it must fit the API's body limit (`MAX_PAYLOAD_BYTES`, 1 MiB by default). An output that cannot be serialised (a `BigInt`, a circular structure) fails the attempt at once with code `output_rejected`, without a retry.

When the API refuses an output (`413` because it is too large, or `400`, for example because a string in it contains a NUL character, which PostgreSQL cannot store), the SDK reports the attempt as a non-retryable failure with code `output_rejected` and a message saying why, because the same output would be refused again. Keep outputs small and store large results elsewhere, returning a reference.

## Throwing errors

A handler fails its attempt by throwing, or by returning a rejected promise. The SDK distinguishes two kinds of error:

| Thrown | Reported as | What happens |
| --- | --- | --- |
| Any error | retryable; `code` is the error's `name` (for example `TypeError`) and `message` is its message | The task is retried according to its retry policy, until its attempts are used up. Then it fails and is dead-lettered. |
| `NonRetryableError(message, code?)` | not retryable; `code` defaults to `non_retryable` | The task fails at once, with no further attempts, and is dead-lettered with reason `non_retryable_error`. |

There is no per-error-type retry configuration. Throw `NonRetryableError` for failures that a retry cannot fix, such as invalid input. Throw anything else for failures that might pass on a later attempt.

The API accepts a failure message of up to 4,000 characters and a code of up to 100. The SDK cuts longer ones to fit (the message ends with `… (truncated)`) and replaces characters the API refuses (a NUL character, an unpaired UTF-16 surrogate) with U+FFFD, so the failure is always recorded and `NonRetryableError` stays non-retryable.

```ts
"invoice.send": async ({ runInput, idempotencyKey, signal }) => {
  const email = String(runInput.email ?? "");
  if (!email.includes("@")) throw new NonRetryableError(`invalid email "${email}"`, "invalid_input");

  const res = await fetch("https://mail.example.com/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ to: email, template: "invoice" }),
    signal,
  });
  if (res.status >= 400 && res.status < 500) {
    throw new NonRetryableError((await res.text()).slice(0, 1_000), "mail_rejected");
  }
  if (!res.ok) throw new Error(`mail API returned ${res.status}`); // retried with backoff
  return { sent: true };
},
```

Retry policies, backoff and dead letters are described in [Reliability](/docs/reliability#retries-and-backoff).

## Checkpoints and resuming

`ctx.saveCheckpoint(data)` stores JSON progress on the task. The next attempt of the same task, whether an automatic retry, a re-delivery after a lost lease or a manual retry, receives the last saved value as `ctx.checkpoint`. The first attempt receives `null`.

```ts
// fetchPage and upsertRows are your own functions.
"orders.backfill": async (ctx) => {
  const saved = ctx.checkpoint as { nextPage: number } | null;
  let page = saved?.nextPage ?? 0;
  for (;;) {
    ctx.signal.throwIfAborted();
    const rows = await fetchPage(page, { signal: ctx.signal });
    if (rows.length === 0) return { pages: page };
    await upsertRows(rows); // idempotent: a repeated page is harmless
    page += 1;
    await ctx.saveCheckpoint({ nextPage: page });
  }
},
```

- **Size.** The serialised JSON may be at most 262,144 bytes (256 KiB) in UTF-8. A larger checkpoint is rejected with `413 checkpoint_too_large`.
- **Fenced.** Only the attempt that holds the current lease can save. After the lease is lost, `saveCheckpoint` throws a `FlowForgeError` with code `lease_lost`, so a stale attempt cannot overwrite a newer attempt's progress.
- **Not retried.** `saveCheckpoint` makes one request. A network or server error is thrown into your handler; if you do not catch it, the attempt fails and is retried.
- **Cost.** Each save is a database write and records a `task.checkpointed` event. Save at meaningful boundaries, not for every item.

A checkpoint does not make side effects exactly-once. A crash between a side effect and the next save repeats that step. Make each step idempotent, as in the example.

## Cancellation and timeouts

`ctx.signal` is aborted in four situations. The abort reason is an `Error` whose message names the cause.

| Cause | When the worker finds out | Abort reason | Reported by the worker |
| --- | --- | --- | --- |
| The run was cancelled | At the next heartbeat, up to one heartbeat interval (10 s by default) after the cancel | `task revoked` | Nothing. The task is already `cancelled`. |
| The lease was lost (expired, or the task was re-leased) | At the next heartbeat that reaches the API | `task revoked` | Nothing. The API's lease reaper records the attempt's outcome. |
| The attempt reached its timeout | When the attempt deadline passes, timed on the worker | `task timeout` | A failure with code `timeout`. The lease ended at the deadline, so the API normally does not apply it; its lease reaper records the attempt as timed out. |
| The worker is shutting down and `drainTimeoutMs` ran out | During `stop()` | `task shutdown` | Nothing. Deregistration releases the task for a retry. |

When the signal aborts, the SDK stops waiting for the handler and frees its slot (after reporting the failure, for a timeout). It cannot stop JavaScript that ignores the signal: that code keeps running in the background, possibly while another attempt of the same task runs elsewhere. Pass `ctx.signal` to `fetch` and other APIs that accept one, and call `ctx.signal.throwIfAborted()` between steps of long work.

Each task's timeout is `timeoutMs` from its definition or the workflow's `defaults`: 5 minutes if neither sets it, and between 1 second and 24 hours. The API sends the remaining time with each task as a duration (`deadlineInMs`), and the SDK times the attempt from that, so the worker host's clock does not need to agree with the API's. Timeouts are retried like other errors. A task that keeps timing out is dead-lettered when its attempts are used up.

## Heartbeats and stalls

The SDK heartbeats automatically. Your handler does not need to do anything. One request per interval (`WORKER_HEARTBEAT_INTERVAL_MS`, 10 seconds by default) covers every task in flight on the worker. For each task the API renews the lease to 30 seconds from now (`LEASE_DURATION_MS`), but never past the attempt's deadline. A renewal succeeds only if the task is still running, still leased to this worker with the same fencing token, and its lease has not already expired. The response lists every task that failed those checks, and the SDK aborts those handlers.

Heartbeats and polls also keep the worker itself registered. A worker the API has not heard from for 60 seconds (`WORKER_OFFLINE_AFTER_MS`) is marked offline.

Heartbeats run on the same event loop as your handlers. Synchronous CPU work that blocks the loop also blocks heartbeats. With the default settings, a block longer than about 20 seconds (the lease duration minus the heartbeat interval) can let a lease expire. Run CPU-heavy work in `worker_threads` or a child process.

If the whole process stalls, for example in a long garbage-collection pause, on a suspended VM or on a laptop with its lid closed:

1. Heartbeats stop. Each lease expires 30 seconds after its last renewal, which is 20 to 30 seconds after the stall began.
2. The API fails those attempts as `lease_expired` and schedules retries, which other workers can claim.
3. When the process resumes, its next heartbeat lists the tasks as revoked and the SDK aborts their handlers. Any result it still reports is discarded: the API answers `409 lease_lost` (logged as a warning), or acknowledges a failure report as a duplicate when the reaper has already failed that attempt. In that case the handler's error is kept with the attempt as `error.reported`, and the dashboard shows it as "Handler reported".
4. If the stall lasted more than 60 seconds, the API has marked the worker offline. Its next heartbeat or poll gets `409 worker_offline`, and the SDK aborts every in-flight task and registers again under a new worker ID.

If the API is unreachable, failed heartbeats are logged and handlers keep running until their deadlines. Completions and failures are sent up to 6 times on network errors, `5xx` and `429` responses, with waits from 250 ms doubling to 4 seconds (about 8 seconds in total). After that the SDK gives up on the report, and the lease expires and the task is retried. The API treats a repeated report of the same attempt as a duplicate and does not apply it twice. Failed polls are retried with backoff from 500 ms doubling to 15 seconds.

## Capacity

The worker reports its free capacity on every poll, and the API leases it only tasks that fit.

- **Slots.** `concurrency` is the number of tasks the worker runs at once. The worker polls only when at least one slot is free.
- **CPU and memory.** `cpu` and `memoryMb` are totals advertised to the scheduler. Free capacity is the total minus the resource requests of the tasks in flight. A task requests 1 CPU and 256 MB unless its definition sets `resources`. These are scheduling units only: the SDK sets no operating-system limits. With the defaults (`concurrency: 4`, `cpu: 4`, `memoryMb: 4096`), four tasks with default requests use all 4 CPU units and 1,024 MB of memory.
- **Task types.** The worker is offered only tasks whose `type` is a key of `handlers`.
- **Queues.** The worker is offered only tasks in the queues listed in `queues`.
- **Capabilities.** The worker is offered only tasks whose `requiredCapabilities` are all in its `capabilities`.

```ts
const gpuWorker = createWorker({
  apiUrl: process.env.FLOWFORGE_API_URL ?? "http://localhost:4000",
  apiKey: process.env.FLOWFORGE_API_KEY ?? "",
  name: "gpu-1",
  queues: ["ml"],
  capabilities: ["gpu"],
  concurrency: 2,
  cpu: 8,
  memoryMb: 32_768,
  handlers: { "model.train": train }, // train is your handler
});
```

A task that no worker can take, because of its queue, type, capabilities or resource requests, stays `queued` without an error. Watch the oldest queued task's age (see [Operations](/docs/operations)).

## Graceful shutdown

`await worker.stop()` shuts the worker down in this order:

1. It stops polling and aborts the long-poll in flight.
2. It sends a heartbeat marked `draining`. The API marks the worker `draining` and leases it no more tasks. The heartbeat also renews the leases of tasks still running.
3. It waits for in-flight tasks to finish, for up to `drainTimeoutMs` (30 seconds by default). Tasks that finish in time report their results as usual.
4. It aborts the signal of every task still running (reason `task shutdown`) and does not report them.
5. It deregisters. The API releases each task still leased to the worker as a failed attempt (kind `lease_expired`, code `worker_shutdown`) and marks the worker offline. Released tasks are retried after their backoff, without waiting for the lease to expire. The release counts as an attempt, so a task on its last allowed attempt is dead-lettered.

If deregistration fails, for example because the API is unreachable, the leases expire on their own and the tasks are retried then.

With `handleSignals: true`, the first `SIGTERM` or `SIGINT` calls `stop()`. The SDK then removes its listeners, so a second signal ends the process at once with Node's default behaviour. Without `handleSignals`, wire it up yourself:

```ts
process.once("SIGTERM", () => {
  void worker.stop().then(() => process.exit(0));
});
```

`stop()` does not exit the process. Without an explicit `process.exit`, Node exits when nothing else keeps it alive, and handler code that ignored its abort signal counts.

The SDK keeps heartbeating, marked `draining`, while tasks are still running, so their leases stay renewed for the whole drain, however long `drainTimeoutMs` is. Give your process supervisor a stop timeout longer than `drainTimeoutMs`, for example Kubernetes `terminationGracePeriodSeconds`.

## Running several workers

Run as many worker processes as you need, on any hosts that can reach the API. Each registers separately with its own worker ID, slots and poll loop, and the API leases each task to one worker at a time. Several `Worker` instances can also share one process, for example to serve two queues with different concurrency.

- Every worker that is not offline counts toward the workspace's `max_active_workers` quota (100 by default).
- Split work with queues and capabilities: a GPU pool serving the `ml` queue with capability `gpu`, and a general pool serving `default`.
- Worker host clocks do not need to be synchronised with the API or with each other.
- A worker is offered only the task types it has handlers for, so workers with different handler sets can serve the same queue.

## Idempotent side effects

FlowForge runs each handler at least once, and sometimes more than once:

- the worker crashed after a side effect but before its completion was recorded;
- the worker stalled or lost its network connection, its lease expired, and another worker ran the task while the first one was still running;
- the attempt timed out, or the worker shut down, while the handler ignored its abort signal;
- the completion could not be reported and the lease expired.

Only one attempt's success is ever recorded (see [Reliability](/docs/reliability)), but external systems see every attempt. Use `ctx.idempotencyKey` to make side effects safe to repeat. It is `<runId>:<taskKey>`: the same for every attempt of a task within a run, and different in every run.

- Pass it to APIs that accept idempotency keys, such as payment and email providers.
- Write with upserts keyed on it, for example `insert … on conflict (idempotency_key) do nothing`.
- If a task has several side effects, derive one key for each: `` `${ctx.idempotencyKey}:charge` ``, `` `${ctx.idempotencyKey}:receipt` ``.
- Two attempts of the same task can overlap in time during a partition. Only deduplication in the external system, which is atomic there, protects against that. Checks inside your handler, such as "did I already save a checkpoint?", do not.
- To get one side effect per business entity across runs, such as one report per day, key on your own identifier from `runInput`, or start runs with a run idempotency key so a resubmission returns the existing run.

```ts
"payments.charge": async ({ runInput, idempotencyKey, signal }) => {
  const res = await fetch("https://payments.example.com/v1/charges", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `${idempotencyKey}:charge` },
    body: JSON.stringify({ customer: runInput.customerId, amountCents: runInput.amountCents }),
    signal,
  });
  if (res.status === 400) throw new NonRetryableError((await res.text()).slice(0, 1_000), "charge_rejected");
  if (!res.ok) throw new Error(`payments API returned ${res.status}`);
  const charge = (await res.json()) as { id: string };
  return { chargeId: charge.id };
},
```
