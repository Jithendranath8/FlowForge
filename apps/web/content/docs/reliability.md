---
title: Reliability
description: What FlowForge guarantees when workers, the network, the API, Redis or the database fail, with the timings and defaults behind each guarantee.
---

FlowForge keeps all durable state in PostgreSQL: runs, tasks, leases, fencing tokens, attempts, events and the outbox of pending notifications. API instances hold no state of their own, Redis carries only wake-up signals, and workers hold nothing the system depends on. This page states the delivery guarantee precisely and then goes through each failure, with the defaults that govern it. Names in capitals are API environment variables (see [Operations](/docs/operations)).

## The guarantee

FlowForge guarantees:

- **At-least-once execution.** Each task that becomes runnable is attempted until one attempt succeeds, the task fails for good (a non-retryable error, or its last allowed attempt fails), or the run is cancelled. A task waits in its queue until a worker that can take it polls. A handler can run more than once for the same task, and two attempts of one task can run at the same time.
- **Exactly-once recorded completion.** A task's success is recorded at most once, only from the attempt that holds the current lease, and `succeeded` is final. Each attempt's outcome is recorded once: a repeated report of the same attempt is acknowledged as a duplicate and not applied again. Dependency resolution runs in the same transaction as the completion, so each downstream task is queued exactly once.
- **Atomic state changes.** A task or run state change commits together with its events, its outbox rows and its effect on downstream tasks, or none of them commit.

FlowForge does not guarantee:

- that a handler runs only once, or that its side effects happen only once. Use the [idempotency key](/docs/workers#idempotent-side-effects) for external writes;
- that a handler stops when its abort signal fires. The SDK stops waiting for it, but cannot interrupt JavaScript that ignores the signal;
- that side effects are rolled back when a task fails or a run is cancelled;
- any ordering between tasks that have no dependency path between them;
- that a result reported after the lease was lost is kept. It is discarded.

## Leases and heartbeats

A worker owns a running task through a lease: an expiry time stored on the task row and renewed by the worker's heartbeats.

| Setting | Default | Meaning |
| --- | --- | --- |
| `LEASE_DURATION_MS` | 30,000 ms | Length of a lease from a claim or renewal. Must exceed twice the heartbeat interval, so one missed heartbeat does not lose a lease. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | 10,000 ms | How often workers heartbeat. Sent to each worker when it registers. |
| `WORKER_OFFLINE_AFTER_MS` | 60,000 ms | A worker with no heartbeat or poll for this long is marked offline. |
| `MAINTENANCE_INTERVAL_MS` | 1,000 ms | How often each API instance reaps expired leases, re-queues retries whose delay has passed, and marks silent workers offline. |

When a worker claims a task, the API increments the task's fencing token and attempt counter, sets the attempt deadline to the claim time plus the task's `timeoutMs`, and sets the lease to expire at the claim time plus `LEASE_DURATION_MS`, or at the attempt deadline if that is sooner.

Each heartbeat renews the lease of every task the worker reports, to `LEASE_DURATION_MS` from now and never past the attempt deadline. A renewal succeeds only if the task is still running, leased to this worker, with the same fencing token, and its lease has not yet expired. An expired lease is never revived, even if the reaper has not processed it yet. The response lists every task that failed these checks, with a reason (`cancelled`, `stale_fence`, `lease_expired`, `not_found`, or the task's current state), and the SDK aborts those handlers.

With the defaults, a worker that stops heartbeating keeps its leases for another 20 to 30 seconds.

## Lease expiry and re-delivery

Every API instance runs the lease reaper once per `MAINTENANCE_INTERVAL_MS`. For each running task whose lease has expired, it locks the run and the task, re-checks the expiry, and records a failed attempt:

- kind `timeout` (attempt outcome `timed_out`) if the attempt deadline has also passed;
- kind `lease_expired` otherwise.

The task's retry policy then moves it to `retry_scheduled` or, if no attempts remain, to `failed`. The next attempt gets a new fencing token and attempt number and can run on any eligible worker.

After a worker crash, with default settings, a task becomes claimable again as follows. These figures are computed from the defaults, not measured:

| Step | Time |
| --- | --- |
| The lease runs out | 20–30 s after the crash (renewed every 10 s, each renewal lasts 30 s) |
| The reaper fails the attempt | Within 1 s of expiry |
| Backoff before the retry (first failure, default policy) | 0.8–1.0 s |
| The retry is re-queued | Within 1 s after the backoff |
| A worker claims it | Within about 100 ms if a worker is long-polling the queue and Redis is healthy, or within 1 s on the polling fallback |

That is roughly 21 to 34 seconds in total. Every re-delivery uses one attempt from the task's retry budget.

The reaper takes at most 20 tasks per workspace and 100 in total per round, and repeats up to 5 rounds per tick while it finds work. A burst of expired leases in one workspace therefore cannot delay another workspace's recovery. Several API instances can reap at once safely, because each state change happens under row locks and re-checks its precondition.

## Fencing tokens and stale completions

Each claim increments the task's fencing token (`fence`). Every request a worker makes about a task carries its worker ID and the fence it was given:

- **Complete and fail** are accepted only if the task is running, the fence and worker ID match, and the lease has not expired by the engine clock. The check runs under the run and task row locks.
- **Heartbeats and checkpoints** use the same conditions in a guarded update.

| Situation | API response | Effect |
| --- | --- | --- |
| The current lease holder reports | `200` | Recorded. Downstream tasks are resolved in the same transaction. |
| The same attempt is reported again, for example when the SDK retries after a lost response, or a failure is reported for an attempt the reaper already failed and no one has re-leased | `200` with `duplicate: true` | The outcome does not change. A failure report for an attempt the API ended by lease expiry or timeout is kept with that attempt as `error.reported` (the first one only), so the handler's own error is not lost. |
| The task was re-leased to another worker | `409 lease_lost` (`stale_fence`) | Discarded. |
| The lease expired, even if no one has reaped or re-leased the task yet | `409 lease_lost` (`lease_expired`) | Discarded. The reaper fails the attempt. |
| The run was cancelled | `409 lease_lost` (`not_running`) | Discarded. |
| A completion arrives for an attempt already resolved another way, for example reaped as `lease_expired` | `409 lease_lost` | Discarded. |

The SDK does not retry a `409`. It logs a warning and drops the result. A paused or partitioned worker therefore cannot overwrite the result of the attempt that replaced it, and because `succeeded` has no outgoing transitions, a recorded success cannot be replaced either.

## Retries and backoff

A task's retry policy comes from its `retry` field, or the workflow's `defaults.retry`, or the built-in default, in that order. A task-level policy replaces the workflow default as a whole; the fields are not merged.

| Field | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `maxAttempts` | 3 | 1–25 | Total attempts, including the first. `1` means no retries. |
| `initialDelayMs` | 1,000 | 0–21,600,000 (6 h) | Delay after the first failure, before jitter. |
| `maxDelayMs` | 60,000 | 0–21,600,000 (6 h), and at least `initialDelayMs` | Upper bound on any delay. |
| `backoffCoefficient` | 2 | 1–10 | Multiplier per further failure. |
| `jitter` | 0.2 | 0–1 | Fraction of the delay that is randomised. |

The delay after the `n`th attempt fails (`n` is 1 after the first failure):

```text
base(n)  = min(maxDelayMs, initialDelayMs × backoffCoefficient^(n − 1))
delay(n) = round(base(n) × (1 − jitter × r)),  r uniform in [0, 1)
```

Jitter only shortens the delay, so a delay never exceeds `maxDelayMs`. With the default policy, the first failure waits 800–1,000 ms and the second waits 1,600–2,000 ms. The third failure is final: the task moves to `failed` and is dead-lettered.

| Failure kind | Cause | Retried |
| --- | --- | --- |
| `error` | The handler threw an error. | Yes |
| `timeout` | The attempt passed its deadline. | Yes |
| `lease_expired` | The lease ran out (crash, stall, partition), or the worker deregistered while holding the task (code `worker_shutdown`). | Yes |
| `non_retryable` | The handler threw `NonRetryableError`. | No |

Every retryable failure uses one attempt. The task waits in `retry_scheduled` until its delay has passed, and the maintenance loop then moves it back to `queued`. The real wait is therefore the delay plus up to one maintenance interval. A re-queued task starts aging from zero again.

### Dead letters and manual retry

When a task fails for good, the API records a dead letter with its reason (`retries_exhausted` or `non_retryable_error`), the number of attempts, and the last error. List them with `GET /v1/dead-letters`. After fixing the cause, retry the task with `POST /v1/tasks/{id}/retry` (scope `runs:write`) or `client.retryTask(taskId)`:

- the task returns to `queued` with a fresh budget of `maxAttempts`, and its attempt numbers continue from where they stopped;
- the tasks it caused to be skipped are re-opened to `pending`;
- a `failed` run returns to `running`;
- the dead letter is marked resolved.

Only `failed` tasks can be retried, and not in a cancelled run (`409 run_cancelled`).

## Timeouts

Each task has a `timeoutMs`: 5 minutes by default, between 1 second and 24 hours. The attempt deadline is the claim time plus `timeoutMs`, on the engine clock. Time spent queued does not count.

The lease is never renewed past the deadline. An attempt that hangs while its worker keeps heartbeating therefore still ends on time. At the deadline the SDK aborts the handler's `signal`, and within one maintenance interval the reaper records the attempt as `timeout`. The retry policy then applies as for any other failure.

There is no timeout for a run as a whole.

## Worker crashes, stalls and partitions

| Failure | What the API sees | Result |
| --- | --- | --- |
| Crash: process killed, host lost | Heartbeats stop | Leases expire after 20–30 s. The attempts fail as `lease_expired` and are retried on any eligible worker. The worker is marked offline 60 s after its last contact. |
| Stall: long GC pause, blocked event loop, suspended VM | Heartbeats stop | The same as a crash. When the process resumes, its next heartbeat revokes the tasks and the SDK aborts their handlers. Results it reports are discarded. After a stall of more than 60 s, the SDK registers again under a new worker ID. |
| Network partition between worker and API | Heartbeats stop | The same as a crash. The worker cannot hear that its leases are gone, so its handlers keep running until their deadlines, while the retries run elsewhere. When the network returns, only the retry's result can be recorded. |
| Graceful shutdown: `stop()`, or `SIGTERM` with `handleSignals` | A `draining` heartbeat, then deregistration | No new tasks are leased to the worker. In-flight tasks get `drainTimeoutMs` (30 s by default) to finish. Tasks still running are then released at once as failed attempts (`lease_expired`, code `worker_shutdown`) and retried after their backoff. |
| The worker cannot report a result (API unreachable through 6 tries over about 8 s) | No completion, and the task is no longer in heartbeats | The lease expires and the task is retried. |

Partitions and stalls are why handlers must tolerate running twice, including concurrently: see [idempotent side effects](/docs/workers#idempotent-side-effects).

## API crashes and restarts

API instances are stateless. Run several behind a load balancer; any instance can serve any request, including successive polls and reports from the same worker.

- **Atomic changes.** Each task or run state change commits in one transaction together with its events and downstream resolution. A crash mid-request rolls the transaction back, leaving the task as it was.
- **Maintenance on every instance.** Lease reaping, retry promotion, offline detection and a check for stalled runs run on every instance unless `RUN_MAINTENANCE=false`. Each step is idempotent and safe to run on several instances at once. If every instance is down, nothing is reaped or re-queued until one starts again, and its maintenance passes then work through the backlog.
- **Workers ride through restarts.** The SDK retries network errors, `5xx` and `429` responses: it sends each report up to 6 times, and retries polls and registration with backoff up to 15 seconds. A long-poll held by a dying instance ends, and the worker polls again.
- **Lost responses.** If an instance commits a completion but dies before answering, the SDK's retry is acknowledged as a duplicate.

### Database outages

PostgreSQL is the source of truth, so FlowForge makes no progress without it. Every database call has a deadline: a 5-second server-side statement timeout, and on the client an 8-second query deadline, a 10-second transaction deadline and a 2-second wait for a pooled connection. A request that hits one of these fails with `503 database_timeout` or `503 database_unavailable` and `Retry-After: 1`. The SDK treats a `503` as transient and retries.

Leases keep running on the engine clock during an outage. If the outage lasts longer than the remaining lease time (20–30 seconds with the defaults), heartbeats cannot renew the leases. Once the database is back, those attempts are reaped and retried, and the original workers' results are rejected. A database outage longer than the remaining lease time can therefore re-run the tasks that were in flight.

## Redis outages

Redis is optional (`REDIS_URL`), and it never holds the only copy of anything. It carries two kinds of signal: "a task was queued on queue Q", which wakes long-polling workers, and "new events exist", which wakes live event streams. PostgreSQL holds the state behind both.

When Redis is healthy, the outbox relay publishes new events every `OUTBOX_RELAY_INTERVAL_MS` (100 ms by default), and each queued task wakes the long-polls waiting on its queue.

An API instance treats Redis as healthy only while both of its connections are open, the latest PING round trip succeeded with no failure since, and that success is recent: within 3 × `REDIS_HEALTH_INTERVAL_MS` + `REDIS_COMMAND_TIMEOUT_MS`, which is 4 seconds with the defaults. Every Redis command times out after `REDIS_COMMAND_TIMEOUT_MS` (1 second by default), so a hung Redis fails commands instead of blocking callers.

While Redis is unhealthy or not configured:

- Long-polls re-check the database every second instead of waiting for a wake-up, so pickup takes up to about a second longer. No work is lost.
- A long-poll that started while Redis was healthy can wait out its full wait (up to 20 seconds) if its wake-up never arrives. The next poll uses one-second re-checks.
- The outbox keeps unpublished rows and relays them when Redis recovers. Without Redis configured, rows are marked handled, since nothing subscribes. A relay that dies mid-publish leaves a claim that lapses after 30 seconds. Wake-ups are delivered at least once, and every receiver re-checks PostgreSQL.
- Lease reaping, retry promotion and offline detection never touch Redis and run in a separate loop from the relay, so they are unaffected.
- Live event streams (`GET /v1/stream`) poll the events table every second.
- `/ready` keeps reporting ready unless `READY_REQUIRES_REDIS=true`.

## The database clock

Leases, attempt deadlines, retry delays and offline detection all compare a time written by one API instance with "now" on another. If each instance used its host clock, an instance whose clock ran ahead could reap leases that another had granted moments earlier. Host clocks do drift: the Docker VM used in development was once observed 1 minute 53 seconds off its host.

FlowForge therefore uses one engine clock for every timestamp it writes:

- With `CLOCK_SOURCE=database` (the default), engine time follows the database server's clock. Each instance reads `clock_timestamp()` (best of 3 by round-trip time) at startup and every `CLOCK_SYNC_INTERVAL_MS` (15 seconds), and advances it with its monotonic clock in between, so changes to the host clock have no effect. Small backward corrections are absorbed; a backward step of more than 1 second is followed and logged. An instance that cannot read the database clock does not start, and a failed resync keeps the previous reading.
- Deadlines cross the network as durations. Each leased task carries `deadlineInMs`, measured on the engine clock when the response is sent, and the SDK times the attempt from it. No component compares another host's timestamp with its own clock, so worker hosts need no clock synchronisation.
- `CLOCK_SOURCE=local` uses the API host's clock. It is meant for a single instance in development.

## Cancellation

Cancel a run with `POST /v1/runs/{id}/cancel` (scope `runs:write`) or `client.cancelRun(runId)`. Only a `running` run can be cancelled; any other state returns `409 run_not_running`.

- **Immediate.** In one transaction, every `pending`, `queued`, `running` and `retry_scheduled` task becomes `cancelled`, running attempts are recorded with outcome `cancelled`, and the run becomes `cancelled`. The API records `task.cancelled` for each task, with its previous state in `from`, and `run.cancelled`. There is no intermediate "cancelling" state.
- **Running handlers** learn of it at their worker's next heartbeat, at most one heartbeat interval later (10 seconds by default). The SDK then aborts `ctx.signal` and reports nothing. A result reported before then is rejected with `409`.
- **Not undone.** Side effects that handlers already performed stay. Tasks that already succeeded keep their outputs.
- **Final.** A cancelled run cannot be resumed, and its tasks cannot be retried. Cancellation applies to whole runs; there is no operation to cancel a single task.

## What to monitor

The API exports Prometheus metrics, and the repository ships alert rules for them. [Operations](/docs/operations) covers setup and runbooks. The signals that matter most for reliability:

| Signal | Metric | Bundled alert |
| --- | --- | --- |
| Attempts ending in lease expiry (crashing, stalled or partitioned workers) | `flowforge_task_attempts_total{outcome="lease_expired"}` | `FlowForgeLeaseExpiriesHigh`: over 5% of attempts for 10 minutes |
| Attempts failing or timing out | `flowforge_task_attempts_total{outcome=~"failed\|timed_out"}` | `FlowForgeTaskFailuresHigh`: over 20% of attempts for 10 minutes |
| Tasks that failed for good | `flowforge_dead_letters_open` | none |
| Tasks waiting for a worker | `flowforge_oldest_queued_task_age_seconds` | `FlowForgeQueueWaitHigh`: over 300 s for 5 minutes |
| Queued tasks with no active worker | `flowforge_tasks{state="queued"}`, `flowforge_workers{state="active"}` | `FlowForgeNoActiveWorkers` |
| Maintenance loop running | `flowforge_background_loop_duration_seconds_count{loop="maintenance"}`, `flowforge_background_loop_errors_total` | `FlowForgeMaintenanceStalled`, `FlowForgeBackgroundLoopFailing` |
| Redis health and wake-up backlog | `flowforge_redis_healthy`, `flowforge_outbox_oldest_unpublished_age_seconds` | `FlowForgeRedisDegraded`, `FlowForgeOutboxBacklog` (over 60 s) |
| Database health | `flowforge_http_errors_total{code=~"database_timeout\|database_unavailable"}`, `flowforge_db_pool_waiting` | `FlowForgeDatabaseErrors`, `FlowForgeDbPoolSaturated` |
| Engine clock | `flowforge_clock_since_sync_seconds` | `FlowForgeClockSyncStale`: over 120 s |

A maintenance loop that has stopped matters most: without it, expired leases are not reaped and retries are not re-queued, even though the API keeps answering requests.
