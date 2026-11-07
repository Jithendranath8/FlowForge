---
title: Security model
description: How FlowForge isolates workspaces, authenticates API keys and dashboard users, protects sessions, limits abuse and keeps secrets out of logs, and what it does not do yet.
---

This page describes how FlowForge authenticates and authorizes callers, how workspaces are kept apart, and what protects the dashboard and the API. It is written for operators and security reviewers, and it lists the limitations that exist today. Settings named here are described on the [operations](/docs/operations) page.

## Tenancy and isolation

A workspace (a *tenant* in the API and database) owns its workflows, runs, tasks, workers, events, API keys and members. Every caller acts in exactly one workspace:

- An API key belongs to one workspace.
- A dashboard session has one active workspace at a time. A user can switch only to a workspace they are a member of.

The API takes the workspace from the credential, never from the request, and every query filters by it. A run, task, worker or key ID from another workspace is answered with 404, the same as an ID that does not exist. Workers lease tasks only from their own workspace, and a task report is accepted only from the worker that holds the task's current lease (its fencing token).

Isolation is enforced in the API's queries. All workspaces share one PostgreSQL database and the API's database role can read all of them; FlowForge does not use PostgreSQL row-level security. Per-workspace quotas (concurrency, active runs, workflows, versions per workflow, active workers) are enforced in the database under a workspace row lock.

## API keys

Programs and workers authenticate with API keys:

```http
Authorization: Bearer ffk_<8-character id>_<43-character secret>
```

- **Generation.** The ID and secret come from 6 and 32 random bytes, base64url-encoded.
- **Storage.** FlowForge stores the key's prefix (`ffk_` and the ID) and the SHA-256 hash of the whole key, never the key itself.
- **Shown once.** The dashboard returns the key only in the response that creates it, and `flowforge-admin create-key` prints it once. Neither can show it again.
- **Expiry.** Keys created in the dashboard can expire after 1 to 3650 days; without a value they do not expire. Keys created with the CLI do not expire.
- **Revocation.** Workspace owners and admins revoke keys in the dashboard; operators use `flowforge-admin revoke-key <prefix>`. Every request looks the key up in PostgreSQL, with no cache, so a revoked or expired key is refused from the next request on. An open live event stream re-checks its key every 30 seconds and closes once the key is refused.
- **Keys cannot manage keys.** Listing, creating and revoking keys requires a signed-in owner or admin, so a leaked key cannot mint more keys.

A header that is not a well-formed key is refused before any database lookup. Every failed attempt counts against the client address's [failed-authentication budget](#rate-limits-and-request-limits). The API records when a key was last used, at most once a minute.

### Scopes

| Scope | Allows |
| --- | --- |
| `read` | Reading workflows, versions, runs, tasks, events, dead letters, workers, members, statistics and scheduling decisions, the workspace's quotas, and the live event stream. |
| `workflows:write` | Registering workflow versions. |
| `runs:write` | Starting and cancelling runs, and retrying tasks. |
| `worker` | Registering a worker, heartbeating, polling for tasks, reporting results and checkpoints, and deregistering. |

Give workers keys with only the `worker` scope. It does not include `read`.

## Roles

Dashboard users have a role in each workspace they belong to. Roles map to the same scopes as API keys, plus key management:

| Action | Owner | Admin | Member | Viewer |
| --- | :-: | :-: | :-: | :-: |
| Read everything in the workspace (`read`) | Yes | Yes | Yes | Yes |
| Register workflows (`workflows:write`) | Yes | Yes | Yes | No |
| Start and cancel runs, retry tasks (`runs:write`) | Yes | Yes | Yes | No |
| List, create and revoke API keys | Yes | Yes | No | No |
| Act as a worker (`worker`) | No | No | No | No |

Owner and admin have the same permissions today, except that only owners can remove owners and admins. Owners and admins can [remove people](#removing-people-and-ending-sessions), but no role can invite members or change roles through the API or the dashboard; see [adding people to a workspace](#adding-people-to-a-workspace).

## Dashboard sign-in

People sign in to the dashboard with Google or GitHub. A provider is enabled when both its client ID and secret are set. Its redirect URL is `${APP_URL}/api/auth/<provider>/callback`, on the web app's origin.

### The OAuth flow

FlowForge uses the OAuth 2.0 authorization code flow with a `state` value and PKCE (S256) for both providers. It asks Google for `openid email profile` and GitHub for `read:user user:email`.

1. `/api/auth/<provider>/start` creates the `state` value and the PKCE verifier and stores them, with the provider and the page to return to, in a cookie signed with HMAC-SHA256 under `SESSION_SECRET`. The cookie is HttpOnly and expires after 10 minutes.
2. The provider sends the browser back to `/api/auth/<provider>/callback`. The API checks the cookie's signature and expiry, that it was issued for this provider, and that `state` matches (compared in constant time). It then clears the cookie.
3. The API exchanges the code, with the PKCE verifier, for an access token, and reads the user's identity. Each provider call times out after 10 seconds. The access token is used only during this request and is not stored.
4. The email must be verified: Google must report `email_verified: true`, and GitHub must have a primary email marked verified. Otherwise sign-in is refused.
5. The email must pass the allowlist (below). The API then finds, links or creates the user and starts a new session.

After sign-in, the browser returns only to a path on `APP_URL`: the return path must start with a single `/`, contain no backslashes or control characters, and be at most 512 characters; otherwise it is `/dashboard`. Failures send the browser to `/sign-in?error=<code>` without provider details. Sign-in starts and callbacks are limited to 30 per client address per minute.

### Who can sign in

| Variable | Default | Effect |
| --- | --- | --- |
| `AUTH_ALLOWED_EMAILS` | empty | Comma-separated email addresses and `@domain` entries, compared case-insensitively. Empty means nobody can sign in. |
| `AUTH_ALLOW_ANY_EMAIL` | `false` | Anyone with a verified Google or GitHub email can sign in, and each new user gets a workspace of their own. |

The allowlist is checked at every sign-in, including for people added with `add-member`, and again whenever a session is used: after you take an address off the list (and restart the API with the new value), that person's sessions end on their next request, and their open live streams within 30 seconds.

### Accounts and linking

- A sign-in identity is the provider plus the provider's account ID. Once linked, it always resolves to the same FlowForge user, even if the email changes at the provider.
- A new identity whose verified email matches an existing user (case-insensitively) is linked to that user, so one person signing in with Google and with GitHub has one account. This is safe only because unverified emails are refused; it also means that whoever controls a verified address at either provider can sign in as the FlowForge user with that address.
- A user with no workspace gets a personal one at first sign-in, as its owner. A user who already has memberships starts in the oldest one.

### Adding people to a workspace

An operator grants access with the admin CLI:

```sh
flowforge-admin add-member <tenant-slug> <email> <owner|admin|member|viewer>
```

This creates the user by email if needed and sets their role; running it again changes the role. The person gets access when they sign in with that verified email, which must also pass the allowlist.

### Removing people and ending sessions

- **In the dashboard**, owners and admins remove people on the Settings page (`DELETE /v1/members/{userId}`). Admins can remove members and viewers; only owners can remove owners and admins, and a workspace always keeps at least one owner.
- **From the command line**, `flowforge-admin remove-member <tenant-slug> <email>` does the same, and `flowforge-admin revoke-sessions <email>` ends every session the person has, in every workspace.

Removal takes effect at once: the person's sessions in that workspace end, their next request fails, and their open live streams close within 30 seconds. API keys belong to the workspace, not to the person who created them, so revoke any keys they made on the API keys page.

## Sessions

| Property | Behaviour |
| --- | --- |
| Token | 32 random bytes in a cookie. The database stores only its SHA-256 hash, so a database leak yields no usable session. |
| Creation | Every sign-in creates a new session; an existing session ID is never reused. |
| Sliding lifetime | Each use extends the session to `SESSION_TTL_HOURS` from now (default 336 hours, 14 days). The extension is written at most once every 5 minutes. |
| Absolute cap | A session never outlives `SESSION_ABSOLUTE_TTL_HOURS` from its creation (default 720 hours, 30 days), however active. |
| Each request | The session is looked up by hash, its expiry checked, and the user's membership of the active workspace confirmed. |
| Logout | `POST /api/auth/logout` deletes the session from the database and clears the cookies. |
| Cleanup | Retention deletes sessions one day past expiry by default (`RETENTION_EXPIRED_SESSIONS_DAYS`). |

FlowForge sets three cookies, all with `Path=/`, no `Domain` and `SameSite=Lax`. When `APP_URL` is `https://` (required in production) they are also `Secure` and their names carry the `__Host-` prefix, which browsers accept only from a secure origin, with `Path=/` and no `Domain`.

| Cookie (on https) | Holds | HttpOnly | Lifetime |
| --- | --- | --- | --- |
| `__Host-ff_session` | The session token | Yes | Until the absolute cap |
| `__Host-ff_csrf` | The session's CSRF token | No, so the web app can send it | Until the absolute cap |
| `__Host-ff_oauth` | Signed OAuth state, PKCE verifier and return path | Yes | 10 minutes, cleared at the callback |

Over plain `http` (development) the names are `ff_session`, `ff_csrf` and `ff_oauth`, without `Secure`.

Rotating `SESSION_SECRET` fails sign-ins in progress and changes every session's CSRF token. Sessions stay valid: the dashboard fetches the new token from `GET /api/auth/me` when it next loads. A client that only has the token from the old cookie has its writes refused until then.

## CSRF and cross-origin requests

- **CSRF token.** A request authenticated by the session cookie with any method other than `GET`, `HEAD` or `OPTIONS` must send an `x-csrf-token` header equal to HMAC-SHA256(`SESSION_SECRET`, session ID). It is compared in constant time, and a missing or wrong token gets 403 `csrf_failed`. This covers every `/v1` write, switching workspace and logout. The dashboard takes the token from `GET /api/auth/me` when it loads and keeps it in memory, falling back to the `ff_csrf` cookie.
- **Origin check.** A request that carries an `Origin` header not on the allowlist (the origin of `APP_URL` plus `ALLOWED_ORIGINS`) and is not `GET` or `HEAD` is refused with 403 `origin_not_allowed`. Only allowlisted origins receive CORS headers, with credentials allowed.
- **SameSite.** The cookies are `SameSite=Lax`, so browsers do not send them on cross-site subrequests.

API-key requests do not use cookies, and when an `Authorization` header is present the session cookie is ignored, so CSRF does not apply to them.

## Rate limits and request limits

| Limit | Default | Keyed by | When exceeded |
| --- | --- | --- | --- |
| Requests before authentication (`RATE_LIMIT_IP_PER_MINUTE`) | 6000 per minute | Client address | 429 `rate_limited`. `/health` is exempt. |
| Failed authentication (`AUTH_FAILURE_LIMIT`, `AUTH_FAILURE_WINDOW_MS`) | 30 per 60 seconds | Client address | 429 `auth_rate_limited`, without a database lookup, even for valid credentials, until the window ends |
| Authenticated requests (`RATE_LIMIT_KEY_PER_MINUTE`) | 1200 per minute | API key, or signed-in user | 429 `rate_limited` |
| Workspace requests (`RATE_LIMIT_TENANT_PER_MINUTE`) | 6000 per minute | Workspace, across all its keys and users | 429 `rate_limited` |
| Sign-in starts and callbacks | 30 per minute | Client address | Redirect to sign-in with `rate_limited` |

Refusals carry a `Retry-After` header. Authenticated responses carry `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` for whichever budget is closer to running out.

The limits are fixed one-minute windows (the failed-authentication window is configurable) counted in memory by each API process, so with N instances the effective limits are N times the configured values. Each limiter tracks at most 50,000 keys. Beyond that it drops expired windows, then the oldest clients still within their limit, and blocked clients only if nothing else is left, so a blocked client cannot clear its own counter by flooding the limiter with other addresses. Per-IP limits count IPv6 clients by their /64 network (one host usually holds a whole /64) and IPv4-mapped IPv6 addresses as IPv4. The client address depends on `TRUST_PROXY`; behind a proxy without it, every client shares the proxy's budget, and a client that can reach a trusted hop directly can choose its own address. See [client addresses behind proxies](/docs/operations#client-addresses-behind-proxies).

Other limits:

- Request bodies are capped at `MAX_PAYLOAD_BYTES` (1 MiB by default) and workflow definitions at `DEFINITION_MAX_BYTES` (256 KiB by default).
- A workspace can hold at most 50 live event streams on each API process. Each open stream re-checks its credential every 30 seconds and closes if access ended; streams are also ended after 30 minutes, and the client reconnects.
- A worker poll waits at most 20 seconds, and a newer poll from the same worker ID on the same API process ends the older one.
- Per-workspace quotas cap concurrency, active runs, workflows, versions and active workers; exceeding one returns 429 `quota_exceeded`.

## Secrets in logs, traces and metrics

- **Headers.** The logger redacts the `Authorization` and `Cookie` request headers and the `Set-Cookie` response header if they are ever logged.
- **URLs.** Request log lines keep the path and query, with the values of credential-like parameters (`code`, `state`, `token`, `key`, `secret`, `password`, `session` and similar) replaced by `[redacted]`, so OAuth callbacks never put their code or state in the logs.
- **Refused sign-ins** are logged with the reason and, for an address not on the allowlist, the email's domain and a 12-character fingerprint (the first 12 hex characters of the SHA-256 of the lowercased address), never the address itself. To check whether someone was refused, compute the fingerprint of their address.
- **Readiness.** `GET /ready` is public, so it reports only statuses (and, while Redis is degraded, when it last answered); why Redis is degraded goes to the log.
- **Database errors.** A failed query's error carries its bound parameters (run inputs, task outputs, checkpoints), and a PostgreSQL error's `detail` can echo a whole row. Before an error reaches the logs or a trace span, FlowForge replaces it with a copy that keeps the SQL text, message and code but drops the parameters, `detail` and `where`.
- **Responses.** Unexpected errors return a generic `internal` error with a request ID; database failures return a generic 503.
- **Traces.** HTTP spans record the route template and the path without its query string. Span attributes carry identifiers and names (workspace, run, task and worker IDs, workflow name, task key, attempt), not run inputs or task outputs.
- **Metrics.** Labels are bounded values such as route templates, outcomes and error codes. There are no workspace, run, task or worker labels.

FlowForge stores run inputs, task outputs and checkpoints as JSON in PostgreSQL and does not encrypt them itself. Use your database's encryption at rest, and keep secrets out of task payloads where you can.

## The web app

Browsers talk only to the web app's origin. It forwards `/api/*` to the API, so the session cookie is first-party and no CORS is involved in normal use.

- **No tokens in browser storage.** The session token is in an HttpOnly cookie that scripts cannot read. The CSRF token, which is useless without the session cookie, is kept in memory and in a readable cookie. Local storage holds only the theme preference. A new API key appears once in the dashboard and is not stored by the browser.
- **Dashboard gate.** Visiting `/dashboard` without a session cookie redirects to sign-in. This only checks that the cookie exists; the API validates the session on every request.

The web app sends these headers on its responses:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |

The policy allows inline scripts and styles, because Next.js bootstraps pages with inline scripts and the theme is set by a small inline script before the page paints. Development builds also allow `'unsafe-eval'`. The web app does not send `Strict-Transport-Security` or `X-Powered-By`; set HSTS where you terminate TLS.

The API itself sends the helmet library's default headers, without a Content-Security-Policy and with `Cross-Origin-Resource-Policy: same-site`, including `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` and `Cross-Origin-Opener-Policy: same-origin`.

## What the API never does

- **It never executes your code.** Workflow definitions are data: tasks, their types, dependencies and retry policies. Task handlers run only in your worker processes; the API stores definitions, resolves dependencies and leases tasks.
- **It never stores credentials in usable form.** API keys and session tokens are stored as SHA-256 hashes, and OAuth access tokens are not stored at all.
- **It never takes the workspace from the request.** The workspace always comes from the API key or the session.
- **It never serves metrics on the public port.** Metrics have their own listener.
- **It never redirects outside `APP_URL` after sign-in.**
- **It never trusts `X-Forwarded-For` unless `TRUST_PROXY` says so**, and it refuses `TRUST_PROXY=true` in production. The web app's server writes that header from the real connection and discards any forwarding header a client sends, so set `TRUST_PROXY` to the web servers' addresses (see [client addresses behind proxies](/docs/operations#client-addresses-behind-proxies)).

## Current limitations

- Isolation between workspaces is enforced by the API's queries, not by database row-level security.
- Rate limits are per process and in memory, not shared across instances.
- Owners and admins have the same permissions, except that only owners can remove owners and admins. "Sign out everywhere" is a CLI command (`revoke-sessions`); the dashboard has no button for it yet.
- A revoked key, ended session or removed member keeps an already open live event stream for up to 30 seconds (the re-check interval).
- The web app's Content-Security-Policy allows inline scripts, and the web app does not send HSTS.
- `/health` and `/ready` need no authentication and are reachable through the web app as `/api/health` and `/api/ready`.
- The metrics listener has no authentication; it must be reachable only by your scraper.
- API keys created with the CLI never expire.
- Run inputs, task outputs and checkpoints are not encrypted by FlowForge.

## Reporting a vulnerability

Report vulnerabilities privately by opening a private security advisory on FlowForge's GitHub repository: on the repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue. Include the affected version or commit, how to reproduce the problem, and its impact as you understand it.
