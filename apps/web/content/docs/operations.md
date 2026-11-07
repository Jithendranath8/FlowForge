---
title: Running FlowForge in production
description: Deploying, configuring, observing and maintaining the FlowForge API, its PostgreSQL database and Redis.
---

This page is for operators. It covers what to deploy, every setting the API reads, how the database and Redis are used, how to run several API instances, and how to observe, verify and maintain a deployment. The security model (sign-in, sessions, API keys, roles) is on the [security](/docs/security) page.

## Architecture

The API is a stateless Node.js HTTP service: run as many instances behind a load balancer as you need. PostgreSQL is the source of truth for everything durable (workflow versions, runs, tasks, leases, attempts, events, sessions and API keys), and API instances coordinate only through it, using row locks. Redis is optional and carries only wake-ups: state changes write an outbox row in Postgres, and a relay publishes it to Redis so idle workers and live dashboards hear about new work at once. Losing Redis loses no state. Workers are your own processes, built with the SDK; they long-poll the API over HTTP, run your task handlers and report results. The API never runs your code. The web app (Next.js) serves the site, these docs and the dashboard, and forwards `/api/*` to the API so browsers talk to a single origin.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 22 or later (CI runs 22.23.3) |
| PostgreSQL | 13 or later (`flowforge-admin verify` fails older servers). CI and the local stack use PostgreSQL 16. |
| Redis | Optional. CI and the local stack use Redis 7. FlowForge uses `PING`, `PUBLISH` and `PSUBSCRIBE`. |
| Connection pooler | Optional. PgBouncer 1.26 in transaction mode has been verified; see [connection poolers](#connection-poolers). |
| Observability | Optional. The shipped configuration targets Prometheus 3.15.1, Grafana 13.2.4 and any OTLP/HTTP trace collector (Jaeger 2.22.0 locally). |

Hosted PostgreSQL and Redis providers have not been verified yet. Run [`flowforge-admin verify`](#verifying-a-deployment) against yours before going live.

## Building and starting

FlowForge does not ship a container image; build it from the repository:

```sh
npm ci
npm run build                     # core, db, SDK and API (TypeScript)
npm run build -w @flowforge/web   # the web app (Next.js); reads API_INTERNAL_URL
node apps/api/dist/main.js        # the API; needs DATABASE_URL and SESSION_SECRET
npm run start -w @flowforge/web   # the web app, on port 3000
```

On start, the API:

1. validates its environment and exits with status 1, listing every problem, if anything is missing or malformed
2. starts tracing, if enabled
3. applies pending database migrations
4. opens the connection pool and connects to Redis, if configured
5. with `CLOCK_SOURCE=database`, syncs the engine clock with the database (startup fails if it cannot read the database clock)
6. starts the metrics listener and the state sampler
7. starts the background loops (maintenance, outbox relay, retention), if `RUN_MAINTENANCE=true`
8. listens on `API_HOST:API_PORT`

The operator CLI is `apps/api/dist/admin.js`, installed as the `flowforge-admin` command. From the repository root, `npm run admin -- <command>` runs it with `.env` loaded if present.

## Configuration

The API reads its configuration from environment variables and validates all of them at startup. Only two are always required: `DATABASE_URL` and `SESSION_SECRET`. Booleans accept `true`, `false`, `1` or `0`.

With `NODE_ENV=production` the API also requires an `https://` `APP_URL` and refuses `TRUST_PROXY=true`. It always checks these relationships:

- `DATABASE_QUERY_TIMEOUT_MS` must exceed `DATABASE_STATEMENT_TIMEOUT_MS` (unless the latter is `0`)
- `DATABASE_TRANSACTION_TIMEOUT_MS` must be at least `DATABASE_QUERY_TIMEOUT_MS`
- `LEASE_DURATION_MS` must exceed twice `WORKER_HEARTBEAT_INTERVAL_MS`
- `SESSION_TTL_HOURS` must not exceed `SESSION_ABSOLUTE_TTL_HOURS`
- each OAuth client ID must be set together with its secret

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `API_HOST` | `127.0.0.1` | Interface the API binds to. Use `0.0.0.0` in containers. |
| `API_PORT` | `4000` | Port the API listens on. |
| `APP_URL` | `http://localhost:3000` | Public URL of the web app. OAuth callbacks and post-sign-in redirects use it, its origin is always allowed for CORS, and an `https://` value turns on secure cookies. Must be `https://` in production. |
| `ALLOWED_ORIGINS` | empty | Extra comma-separated origins allowed to make credentialed cross-origin requests. Writes carrying any other `Origin` are refused with 403. |
| `TRUST_PROXY` | `false` | Whose `X-Forwarded-For` to believe when working out the client address for per-IP limits: the web servers' addresses or CIDRs (`127.0.0.1` on one host). `false` believes no one. See [client addresses behind proxies](#client-addresses-behind-proxies). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `API_URL` | `http://localhost:4000` | Validated as a URL but not used by the API today. |

### Database

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://` or `postgresql://` connection string. Use `sslmode=verify-full` for a remote server. |
| `DATABASE_POOL_MAX` | `10` | Connections per API process (1–100). |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `5000` | Server-side `statement_timeout`, sent as a connection startup parameter. `0` stops sending it. |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `15000` | Server-side `idle_in_transaction_session_timeout`, sent the same way. `0` stops sending it. |
| `DATABASE_ACQUIRE_TIMEOUT_MS` | `2000` | Longest wait for a pooled connection when all are busy. |
| `DATABASE_QUERY_TIMEOUT_MS` | `8000` | Client-side deadline for one statement, including the network. Holds even if the server or network freezes. |
| `DATABASE_TRANSACTION_TIMEOUT_MS` | `10000` | Client-side deadline for a whole transaction. When it fires, the transaction is rolled back if it is still running. |

### Redis

| Variable | Default | Description |
| --- | --- | --- |
| `REDIS_URL` | unset | `redis://` or `rediss://` URL. Unset: workers and live streams poll Postgres instead. Use `rediss://` for any remote host. |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | Deadline for each Redis command, so a hung Redis fails fast instead of blocking. |
| `REDIS_HEALTH_INTERVAL_MS` | `1000` | How often both Redis connections are pinged. Redis counts as healthy only after a recent successful round trip. |

### Sign-in and sessions

How these are used is described on the [security](/docs/security) page.

| Variable | Default | Description |
| --- | --- | --- |
| `SESSION_SECRET` | required | At least 32 characters. Signs the OAuth state cookie and derives CSRF tokens. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. |
| `SESSION_TTL_HOURS` | `336` (14 days) | Sliding lifetime: a session unused for this long expires (1–2160). |
| `SESSION_ABSOLUTE_TTL_HOURS` | `720` (30 days) | Hard cap on a session's age, however active (1–8760). |
| `AUTH_ALLOWED_EMAILS` | empty | Comma-separated email addresses and `@domain` entries allowed to sign in. Empty means nobody, unless `AUTH_ALLOW_ANY_EMAIL` is set. |
| `AUTH_ALLOW_ANY_EMAIL` | `false` | Let anyone with a verified email sign in; each new user gets a private workspace. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Google OAuth client. Set both to enable Google sign-in. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | GitHub OAuth app. Set both to enable GitHub sign-in. |

Register `${APP_URL}/api/auth/google/callback` and `${APP_URL}/api/auth/github/callback` as the redirect URLs with each provider. If a provider is configured but the allowlist is empty and `AUTH_ALLOW_ANY_EMAIL` is off, the API logs a warning at startup, because nobody can sign in.

### Request limits

All rate limits are counted in memory by each API process; see [running several instances](#running-several-api-instances).

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_PAYLOAD_BYTES` | `1048576` (1 MiB) | Largest request body, such as a run input or task output (1 KiB–10 MiB). |
| `DEFINITION_MAX_BYTES` | `262144` (256 KiB) | Largest workflow definition, as canonical JSON. Larger ones get 413 `definition_too_large`. |
| `RATE_LIMIT_IP_PER_MINUTE` | `6000` | Requests per minute per client address, checked before authentication. `/health` is exempt. `0` disables. |
| `RATE_LIMIT_KEY_PER_MINUTE` | `1200` | Requests per minute per API key, or per signed-in user. |
| `RATE_LIMIT_TENANT_PER_MINUTE` | `6000` | Requests per minute per workspace, across all its keys and users. |
| `AUTH_FAILURE_LIMIT` | `30` | Failed authentication attempts allowed per client address per window. Further attempts get 429 `auth_rate_limited` without a database lookup until the window ends. |
| `AUTH_FAILURE_WINDOW_MS` | `60000` | Window for `AUTH_FAILURE_LIMIT`. |

Per-workspace quotas (concurrency, active runs, workflows, versions, active workers) live in the database, not the environment. Change them with `flowforge-admin set-quota` and inspect them with `flowforge-admin show-quota`.

### Engine

| Variable | Default | Description |
| --- | --- | --- |
| `LEASE_DURATION_MS` | `30000` | Task lease length. Shorter leases recover from worker crashes faster but need more heartbeat traffic. |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat interval the API tells workers to use. |
| `WORKER_OFFLINE_AFTER_MS` | `60000` | Silence after which a worker is marked offline. |
| `MAINTENANCE_INTERVAL_MS` | `1000` | Period of the maintenance loop: reaps expired leases, promotes due retries, marks silent workers offline and resumes stalled runs. |
| `RUN_MAINTENANCE` | `true` | Run the background loops (maintenance, outbox relay, retention) in this process. Safe on every instance. |
| `OUTBOX_RELAY_INTERVAL_MS` | `100` | Period of the outbox-to-Redis relay. |
| `CLOCK_SOURCE` | `database` | Engine time source. `database` follows the database server's clock; `local` uses the host clock and is for a single instance only. See [the database clock](#the-database-clock). |
| `CLOCK_SYNC_INTERVAL_MS` | `15000` | How often the engine clock re-reads the database clock (1 s–10 min). |
| `PREDICTIVE_SCHEDULING` | `true` | Accepted and validated, but has no effect in the current release. |

### Readiness

| Variable | Default | Description |
| --- | --- | --- |
| `READY_TIMEOUT_MS` | `2000` | `/ready` always answers within this time, even if the database hangs. |
| `READY_REQUIRES_REDIS` | `false` | If `true`, `/ready` also fails while Redis is unhealthy. Off by default because the engine stays correct without Redis. |

### Retention

| Variable | Default | Description |
| --- | --- | --- |
| `RETENTION_RUNS_DAYS` | `30` | Finished runs, with their tasks, attempts, dead letters and events. `0` keeps them. |
| `RETENTION_WORKER_EVENTS_DAYS` | `30` | History events not tied to a run (worker registrations, offline, deregistrations). `0` keeps them. |
| `RETENTION_SCHEDULING_DECISIONS_DAYS` | `14` | Per-lease scheduling decisions. `0` keeps them. |
| `RETENTION_OFFLINE_WORKERS_DAYS` | `7` | Workers that have been offline this long. `0` keeps them. |
| `RETENTION_EXPIRED_SESSIONS_DAYS` | `1` | Dashboard sessions this long past expiry. `0` keeps them. |
| `RETENTION_OUTBOX_HOURS` | `24` | Outbox rows already relayed to Redis (1–8760; cannot be disabled). |
| `RETENTION_INTERVAL_MS` | `600000` (10 min) | Period of the retention pass. |
| `RETENTION_BATCH_SIZE` | `500` | Rows per delete statement; runs are deleted a tenth as many at a time, since each carries its tasks. |
| `RETENTION_MAX_BATCHES` | `20` | Delete statements per category per pass. |

### Metrics and tracing

| Variable | Default | Description |
| --- | --- | --- |
| `METRICS_HOST` | `127.0.0.1` | Interface of the separate Prometheus listener. Bind it to an address only your scraper can reach. |
| `METRICS_PORT` | `9464` | Port serving `GET /metrics`. `0` disables the listener. |
| `METRICS_STATE_INTERVAL_MS` | `15000` | How often this instance samples queue depth, backlog, workers and dead letters from Postgres. `0` disables sampling here. |
| `TRACING_ENABLED` | `false` | Export OpenTelemetry traces over OTLP/HTTP. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP base URL; spans go to `<endpoint>/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Standard OpenTelemetry variable for extra export headers, such as a vendor API key. |
| `OTEL_SERVICE_NAME` | `flowforge-api` | `service.name` on exported spans. |
| `TRACING_SAMPLE_RATIO` | `1` | Fraction of new traces sampled (0–1). |

### Web app and workers

| Variable | Read by | Description |
| --- | --- | --- |
| `API_INTERNAL_URL` | web app, at `next build` | Where the web app forwards `/api/*`. Defaults to `http://127.0.0.1:4000`. It is written into the build output, so rebuild after changing it. |
| `FLOWFORGE_API_URL`, `FLOWFORGE_API_KEY` | the example worker | The API URL and a key with the `worker` scope. The SDK takes them as `apiUrl` and `apiKey` options; these names are a convention of the examples. |

## Database

### Migrations

The API applies pending migrations when it starts, over a dedicated connection. Every `flowforge-admin` command except `verify` does the same before it runs. Each migrator runs in one transaction that holds a transaction-level PostgreSQL advisory lock, so instances that start together migrate one after another and the later ones find nothing pending. This works over a direct connection and through a transaction-mode pooler alike: the transaction stays on one server connection, and the lock ends with it, including when a migration fails or the process dies. Migrations must therefore be transactional (no `CREATE INDEX CONCURRENTLY`).

Migrations `0003`, `0005`, `0006` and `0007` create indexes inside the migration transaction, not `CONCURRENTLY`, so writes to the indexed tables wait until the migration commits. On a large existing database, upgrade at a quiet time. Do not create these indexes by hand beforehand: the migrations do not use `IF NOT EXISTS` and would fail.

### TLS

Use `sslmode=verify-full` (or `sslrootcert=system`) in `DATABASE_URL` for any remote server. With `sslmode=require` the connection is encrypted but the server's certificate is not verified. `flowforge-admin verify` reports a remote connection without TLS as FAIL and `require` or `verify-ca` as WARN.

### Timeouts

The API bounds every database call twice. On the server, `statement_timeout` (5 s) and `idle_in_transaction_session_timeout` (15 s) are sent as startup parameters, so a live server cancels slow statements and ends abandoned transactions. On the client, every statement has a deadline (8 s) and every transaction another (10 s); these hold even when the server or network is frozen. A request that hits either answers 503 with `database_timeout` or `database_unavailable` and a `Retry-After: 1` header.

### Connection poolers

The API's connection pool does not use prepared statements, so it works with a transaction-mode pooler. The server-side timeouts need care, because they travel as startup parameters. Measured with PgBouncer 1.26 in transaction mode:

| Pooler configuration | Result with the default settings | What to do |
| --- | --- | --- |
| Default | Every connection is refused (`unsupported startup parameter: statement_timeout`); the API cannot start. | Set `DATABASE_STATEMENT_TIMEOUT_MS=0` and `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS=0`, and set both timeouts on the role the API connects as. |
| Timeouts listed in `ignore_startup_parameters` | Connects, but the server-side timeouts are silently dropped. | The same. `flowforge-admin verify` reports this as FAIL. |
| Role-level timeouts, startup parameters disabled | All checks pass. | Nothing more. |

For example, if the API connects as `flowforge`:

```sql
ALTER ROLE flowforge SET statement_timeout = '5s';
ALTER ROLE flowforge SET idle_in_transaction_session_timeout = '15s';
```

The admin CLI reads the same two variables, so it works behind such a pooler too.

### Connection budget

Each API process opens up to `DATABASE_POOL_MAX` connections, and migrations use one more. Make sure the server (or pooler) allows `DATABASE_POOL_MAX` × the number of instances, plus headroom for the admin CLI. `flowforge-admin verify --instances N` checks this against `max_connections`, the role's connection limit and current usage.

## Redis

Redis is only for wake-ups. When Redis is not configured, down or hung:

- worker long-polls re-check Postgres every second instead of waiting for a wake-up, so pickup takes up to about a second
- the outbox keeps every unrelayed row until Redis is back; nothing is lost
- live event streams poll Postgres every second
- maintenance, retention and the lease reaper are unaffected, because the relay runs in its own loop
- `/ready` stays healthy unless `READY_REQUIRES_REDIS=true`

The notifier pings Redis every `REDIS_HEALTH_INTERVAL_MS` and gives up on any command after `REDIS_COMMAND_TIMEOUT_MS`. The `FlowForgeRedisDegraded` and `FlowForgeOutboxBacklog` alerts tell you when wake-ups are delayed. Use `rediss://` for a remote Redis; the client verifies its certificate.

## Running several API instances

API instances share nothing but PostgreSQL (and Redis, if configured), so you can run as many as you need behind a load balancer.

- Keep `CLOCK_SOURCE=database` (the default). With `local`, each instance would check leases against its own host clock.
- Run the background loops with `RUN_MAINTENANCE=true` on at least one instance. The maintenance loop, the outbox relay and retention all run only where it is set. Every pass takes its rows with row locks or `SKIP LOCKED`, so running them on every instance is safe, though partly redundant.
- Rate limits are counted per process: with N instances, the effective per-minute limits are N times the configured values. Quotas are enforced in the database, under a workspace row lock, so they are exact across instances.
- System-state metrics are global values that every sampling instance reports, so aggregate them with `max()`, never `sum()`. On a large deployment, set `METRICS_STATE_INTERVAL_MS=0` on all but a few instances.
- Live event streams are limited to 50 per workspace in each process.
- Check the connection budget with `flowforge-admin verify --instances N`.

### Client addresses behind proxies

Per-IP rate limits and the failed-authentication limit key on the client address, so the API must learn the real one, and only from components that know it.

- **The web server sets it.** Run the web app with `npm start -w @flowforge/web` (`apps/web/server.mjs`). For every request it works out the client address and sends it to the API as the only `X-Forwarded-For` entry; it drops any `X-Forwarded-For`, `X-Real-IP` or `Forwarded` header the client wrote. The address is its connection's peer, or, when `WEB_TRUST_PROXY` names load balancers in front of it, the address they report.
- **The API believes only the web server.** Set `TRUST_PROXY` on the API to the web servers' addresses: `127.0.0.1` when they share a host (the quick start's layout), otherwise their private addresses or CIDR. Requests from anywhere else, including workers that connect to the API directly, are identified by their own connection and cannot choose an address.
- **`WEB_TRUST_PROXY`** is unset (`false`) when browsers connect to the web server directly. Behind load balancers, set it to their hop count or addresses, and make the web server reachable only through them.

Avoid a hop count in `TRUST_PROXY`: it trusts whatever connects, so any client that can reach the API port directly can set `X-Forwarded-For` itself (the API warns at start). `TRUST_PROXY=true` is refused in production. With `TRUST_PROXY=false`, every browser request arrives from the web server and all browsers share one budget, so one client exceeding the failed-authentication limit locks out everyone using the dashboard until the window ends.

`next start` and `next dev` forward client-written forwarding headers unchanged and add no client address of their own, so do not expose them; `npm run dev -w @flowforge/web` listens on loopback only.

## Health checks and graceful shutdown

| Endpoint | Use | Behaviour |
| --- | --- | --- |
| `GET /health` | Liveness | Always 200 `{"status":"ok"}`. No I/O, and exempt from the per-IP limit. |
| `GET /ready` | Readiness, load balancer routing | 200 when the database answers `select 1` within `READY_TIMEOUT_MS`, otherwise 503. The body reports `database` (`ok`, `timeout` or `unavailable`) and `redis` status. Redis decides readiness only with `READY_REQUIRES_REDIS=true`. |

Both are served on the API port without authentication.

On `SIGTERM` or `SIGINT` the API shuts down in this order:

1. stops accepting connections, ends open live event streams and waits for in-flight requests (a worker long-poll can last up to 20 seconds)
2. stops the background loops after their current pass finishes
3. stops the state sampler and closes the metrics listener
4. closes Redis, stops the engine clock and closes the database pool
5. flushes buffered trace spans, then exits with status 0

Leases live in PostgreSQL, so work in progress is unaffected: workers keep heartbeating and reporting through the other instances. Give the process more than 20 seconds before a forced kill.

## The database clock

Every timestamp the engine writes or compares (lease expiries, deadlines, retry times, events) comes from one engine clock. With `CLOCK_SOURCE=database`, each instance reads the database server's clock (`clock_timestamp()`, best of three by round trip) every `CLOCK_SYNC_INTERVAL_MS` and advances it with the local monotonic clock in between. All instances therefore agree on when a lease expires, whatever their host clocks say, and host clock steps between syncs have no effect.

- Engine time never moves backwards within a process. A backward correction is absorbed, unless the database clock steps back by more than a second, in which case the engine follows it and logs a warning.
- A failed sync keeps the previous anchor, and the instance keeps running.
- Startup fails if the database clock cannot be read.
- Deadlines sent to workers are durations, so workers never compare engine timestamps with their own clocks.

The `flowforge_clock_*` metrics show each instance's offset from the database clock and the time since its last sync. A large offset is informational: it means the host clock is off, and the engine does not use the host clock.

## Metrics

Each API process serves Prometheus metrics at `GET /metrics` on a separate listener (`METRICS_HOST:METRICS_PORT`, default `127.0.0.1:9464`). The public API port never serves metrics, and the listener has no authentication, so bind it to a private address and never expose it publicly. Scrape every instance.

All series are prefixed `flowforge_`, except the standard Node.js process metrics (`process_*`, `nodejs_*`).

| Group | Series | Notes |
| --- | --- | --- |
| HTTP | `http_requests_total{method,route,status_class}`, `http_request_duration_seconds{method,route}` | `route` is the route template, or `unmatched`. Worker long-polls wait by design; leave `/v1/workers/:id/poll` out of latency views. |
| Errors | `http_errors_total{code}`, `quota_rejections_total{quota}` | Codes include `database_timeout`, `database_unavailable`, `internal`, `rate_limited`, `auth_rate_limited`, `quota_exceeded`. |
| Engine | `tasks_leased_total`, `task_queue_wait_seconds`, `task_attempts_total{outcome}`, `task_attempt_duration_seconds{outcome}`, `runs_started_total`, `runs_finished_total{state}`, `run_duration_seconds{state}`, `events_total{type}` | Derived from the history events every state change writes. Outcomes: `succeeded`, `failed`, `timed_out`, `lease_expired`, `cancelled`. |
| Background | `background_loop_duration_seconds{loop}`, `background_loop_errors_total{loop}`, `maintenance_rows_total{action}`, `retention_deleted_rows_total{category}`, `retention_backlog` | Loops: `maintenance`, `outbox-relay`, `retention`. |
| State (sampled) | `tasks{state}`, `oldest_queued_task_age_seconds`, `runs_active`, `outbox_unpublished`, `outbox_oldest_unpublished_age_seconds`, `workers{state}`, `dead_letters_open`, `state_sample_age_seconds`, `state_sample_errors_total` | Sampled from Postgres every `METRICS_STATE_INTERVAL_MS`. Global values: aggregate with `max()`. |
| Dependencies | `db_pool_size`, `db_pool_in_use`, `db_pool_waiting`, `redis_enabled`, `redis_healthy`, `redis_consecutive_failures` | Read at scrape time. |
| Clock | `clock_offset_seconds`, `clock_uncertainty_seconds`, `clock_since_sync_seconds`, `clock_sync_failures` | See [the database clock](#the-database-clock). |
| Streams | `sse_streams` | Open live event streams in this process. |

Label values are bounded: route templates (never raw URLs), methods, status classes, error codes, quotas, outcomes, states, loops, actions, categories and event types. There are no workspace, run, task or worker labels. Every label combination the alerts depend on is exported at zero from process start, so the first burst of errors after a restart still shows up in `rate()`.

Engine counters are incremented inside the transaction that writes the event. A transaction that then rolls back leaves a count without its event; the event history remains the audit trail.

### Grafana dashboard

`deploy/observability/grafana/dashboards/flowforge-overview.json` is a 29-panel dashboard, *FlowForge — Operations*, in seven rows: health, throughput, latency, backlog and capacity, errors and protection, maintenance and retention, and process and clock. It has a data source variable, so you can import it into your own Grafana and pick your Prometheus.

To try the whole stack locally:

```sh
docker compose --profile observability up -d   # Prometheus :59090, Grafana :53001, Jaeger UI :56686, OTLP :54318
```

The local Prometheus scrapes `host.docker.internal:9464`. Docker Desktop forwards that to the host's loopback, so the default `METRICS_HOST` works. On Linux, bind `METRICS_HOST` to the Docker bridge address rather than `0.0.0.0`.

### Alert rules

`deploy/observability/prometheus/rules/flowforge.yml` holds 14 alert rules. Load it into your Prometheus as is.

| Alert | Severity | Fires when |
| --- | --- | --- |
| `FlowForgeApiDown` | critical | An instance cannot be scraped for 1 minute. |
| `FlowForgeNoActiveWorkers` | critical | Tasks are queued and no worker is active, for 2 minutes. |
| `FlowForgeQueueWaitHigh` | warning | The oldest queued task has waited more than 5 minutes, for 5 minutes. |
| `FlowForgeLeaseExpiriesHigh` | warning | Over 10 minutes, more than 5% of attempts end in lease expiry; sustained for 10 minutes. |
| `FlowForgeTaskFailuresHigh` | warning | Over 10 minutes, more than 20% of attempts fail or time out; sustained for 10 minutes. |
| `FlowForgeDatabaseErrors` | critical | The API keeps answering 503 `database_timeout` or `database_unavailable` for 2 minutes. |
| `FlowForgeDbPoolSaturated` | warning | Queries wait for a database connection, for 5 minutes. |
| `FlowForgeMaintenanceStalled` | critical | No maintenance pass completed on any instance in 3 minutes, sustained for 2 minutes. |
| `FlowForgeBackgroundLoopFailing` | warning | A background loop keeps failing for 3 minutes. |
| `FlowForgeRedisDegraded` | warning | Redis is configured but unhealthy on an instance, for 2 minutes. |
| `FlowForgeOutboxBacklog` | warning | The oldest unrelayed wake-up is older than 60 seconds, for 5 minutes. |
| `FlowForgeClockSyncStale` | warning | An instance has not synced its engine clock for over 2 minutes, sustained for 5 minutes. |
| `FlowForgeStateSamplerStale` | warning | No instance has sampled the state gauges for over 2 minutes, sustained for 5 minutes. |
| `FlowForgeRetentionBehind` | info | Retention has been working through a backlog for 6 hours. |

`FlowForgeStateSamplerStale` takes the lowest age among instances that sample (`min(flowforge_state_sample_age_seconds >= 0)`). An instance with sampling switched off (`METRICS_STATE_INTERVAL_MS=0`) reports `-1` and is left out; an instance whose sampler has never succeeded counts from when it started, so it still turns stale.

`flowforge.test.yml`, next to the rules, holds `promtool` unit tests: 8 test cases covering 7 of the 14 alerts, with rules evaluated every 15 seconds. Run them with:

```sh
docker run --rm -v "$PWD/deploy/observability/prometheus/rules:/r:ro" -w /r \
  --entrypoint promtool prom/prometheus:v3.15.1 test rules flowforge.test.yml
```

## Tracing

Tracing is off by default. Set `TRACING_ENABLED=true` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP/HTTP collector; add vendor credentials with `OTEL_EXPORTER_OTLP_HEADERS`. When tracing is off, nothing is recorded or exported.

A workflow run is one trace. It contains:

- the submission request and its `flowforge.submit_run` span
- every report a worker sends for the run's tasks (complete, fail, checkpoint), because the SDK sends the run's `traceparent` with them
- `flowforge.complete_task` and `flowforge.fail_task`
- maintenance on the run: `flowforge.reap_lease`, `flowforge.promote_retries`, `flowforge.resume_run`

A worker's claim (`flowforge.claim_tasks`) belongs to the poll request's own trace and links to every run whose tasks it leased. A report that arrives without the run's context is linked to the run's trace. HTTP spans are named by route template. Handlers can add their own spans to the run's trace from `ctx.traceparent`.

`TRACING_SAMPLE_RATIO` samples new traces; an incoming sampled `traceparent` is always followed, and request rate limits bound how much tracing a client can force. To find a run's trace, read `traceContext` from `GET /v1/runs/:id`: it is a W3C `traceparent` (`00-<trace id>-<span id>-<flags>`), or `null` if tracing was off when the run was created.

There are no database or Redis client spans; engine spans include the time spent in them.

## Logging

The API writes JSON logs (pino) to standard output, at `LOG_LEVEL`. Lines written during a traced request carry `trace_id` and `span_id`. Every request gets a random request ID, which also appears in error responses as `requestId`; the API ignores client-supplied request ID headers.

The `Authorization` and `Cookie` request headers and the `Set-Cookie` response header are redacted if they are ever logged. Logged errors pass through a serializer that removes a failed query's bound parameters and PostgreSQL's row `detail`, so run inputs and task outputs do not reach the logs through errors. FlowForge does not ship logs anywhere; collect standard output with your platform's tooling.

## Data retention

Retention deletes execution history that has aged out. It runs on every instance with `RUN_MAINTENANCE=true`, every `RETENTION_INTERVAL_MS`, and measures ages in engine time.

| Category | Variable | Default |
| --- | --- | --- |
| Finished runs, with their tasks, attempts, dead letters and events | `RETENTION_RUNS_DAYS` | 30 days |
| Events not tied to a run | `RETENTION_WORKER_EVENTS_DAYS` | 30 days |
| Scheduling decisions | `RETENTION_SCHEDULING_DECISIONS_DAYS` | 14 days |
| Offline workers | `RETENTION_OFFLINE_WORKERS_DAYS` | 7 days |
| Sessions past expiry | `RETENTION_EXPIRED_SESSIONS_DAYS` | 1 day |
| Relayed outbox rows | `RETENTION_OUTBOX_HOURS` | 24 hours |

`0` keeps a category forever (except the outbox). Retention never deletes workspaces, users, API keys, workflows or workflow versions, task-type statistics, unfinished runs, or outbox rows not yet relayed. A run reopened by a manual retry is not finished. A failed run's dead letters are deleted with the run, so keep `RETENTION_RUNS_DAYS` long enough to act on them.

Each pass deletes in bounded batches: at most `RETENTION_BATCH_SIZE` rows per statement (runs a tenth as many) and `RETENTION_MAX_BATCHES` statements per category. A pass that stops at the limit sets `flowforge_retention_backlog` to 1 and runs again after one second, until the backlog is gone. Runs are taken with `SKIP LOCKED`, so a run being retried or cancelled is skipped rather than waited on. On local PostgreSQL 16, 20,000 aged runs (100,000 tasks, 240,000 events) were deleted in 5.8 seconds, with no pass longer than 418 ms.

To see or drain the backlog by hand:

```sh
flowforge-admin retention           # rows eligible in each category under the RETENTION_* policy; deletes nothing
flowforge-admin retention --apply   # delete them now, in the same bounded batches
```

The command takes its policy from the `RETENTION_*` variables and prints JSON.

## Verifying a deployment

`flowforge-admin verify` checks a PostgreSQL and Redis deployment before you rely on it, typically a hosted provider. It connects exactly as the API does, is read-only (it runs no migrations and writes nothing), and exits with status 1 if any check fails.

```sh
DATABASE_URL=… REDIS_URL=… flowforge-admin verify [--instances N] [--json]
```

It reads `DATABASE_URL`, `REDIS_URL`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` and `REDIS_COMMAND_TIMEOUT_MS`, and reports PASS, WARN, FAIL or INFO for each check.

PostgreSQL:

- **TLS:** whether the URL requires TLS with certificate and hostname verification (local hosts are exempt)
- **Server version:** 13 or later
- **Startup parameters:** whether `statement_timeout` and `idle_in_transaction_session_timeout` arrive as sent, and where each value came from; a pooler that rejects or drops them is reported with the fix
- **Statement timeout enforced:** a statement that outlives `statement_timeout` is cancelled
- **Transaction integrity:** 8 concurrent transactions each keep one server connection throughout
- **Clock:** the database clock's offset from this host (WARN beyond 1 second)
- **Round trip:** p50 and p95 latency over 20 queries (WARN above 100 ms at p95)
- **Connections:** headroom for `DATABASE_POOL_MAX` × `--instances`, plus migrations
- **Migrations:** how many of this build's migrations are applied

Redis (or INFO if `REDIS_URL` is unset):

- **TLS:** `rediss://` for remote hosts
- **Ping:** latency over 10 pings (WARN above 100 ms at p95)
- **Pub/sub:** a `PSUBSCRIBE` and a pipelined `PUBLISH`, the notifier's exact mechanism, on a channel the API never uses

## Admin CLI

All commands need `DATABASE_URL`. Every command except `verify` applies pending migrations first.

| Command | What it does |
| --- | --- |
| `create-tenant <slug> [name]` | Creates a workspace. |
| `create-key <tenant-slug> <name> <scopes>` | Creates an API key and prints it once. Scopes: `workflows:write`, `runs:write`, `read`, `worker`. |
| `revoke-key <prefix>` | Revokes the key with this prefix (`ffk_` and 8 characters). |
| `show-quota <tenant-slug>` | Prints the workspace's quotas and usage. |
| `set-quota <tenant-slug> <quota> <value>` | Changes a quota (`max_concurrency`, `max_active_runs`, `max_workflows`, `max_versions_per_workflow`, `max_active_workers`). |
| `add-member <tenant-slug> <email> <owner\|admin\|member\|viewer>` | Gives an email address a role in a workspace; see [security](/docs/security#adding-people-to-a-workspace). |
| `remove-member <tenant-slug> <email>` | Takes a person out of a workspace and ends their sessions in it (never the last owner); see [security](/docs/security#removing-people-and-ending-sessions). |
| `revoke-sessions <email>` | Ends every session a person has ("sign out everywhere"). |
| `retention [--apply]` | Reports, or drains, the retention backlog. |
| `verify [--instances N] [--json]` | Checks `DATABASE_URL` and `REDIS_URL`. |

## Production checklist

- `NODE_ENV=production` and an `https://` `APP_URL`.
- `DATABASE_URL` with `sslmode=verify-full`, and `REDIS_URL` with `rediss://`, for remote servers.
- `flowforge-admin verify --instances N` passes against the production database and Redis.
- Behind a transaction-mode pooler: startup-parameter timeouts set to `0` and set on the role instead.
- A random `SESSION_SECRET` of at least 32 characters, stored as a secret.
- Google and/or GitHub configured with `${APP_URL}/api/auth/<provider>/callback`, and `AUTH_ALLOWED_EMAILS` set.
- The web app runs with `npm start -w @flowforge/web`, `TRUST_PROXY` lists the web servers' addresses, `WEB_TRUST_PROXY` matches any load balancers in front of the web app, and nothing reaches the web servers or the API port around them.
- `CLOCK_SOURCE=database`, and `RUN_MAINTENANCE=true` on at least one instance.
- The load balancer routes on `/ready`, liveness probes use `/health`, and the termination grace period is over 20 seconds.
- Upgrades that bring new migrations start one instance before the rest.
- The metrics listener is on a private address and scraped on every instance; alert rules loaded; dashboard imported.
- Retention periods reviewed, especially `RETENTION_RUNS_DAYS` against how long you need dead letters.
- The web app built with the right `API_INTERNAL_URL`.
