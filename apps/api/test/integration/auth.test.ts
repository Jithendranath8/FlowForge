import { schema, type DbHandle } from "@flowforge/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Writable } from "node:stream";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseAllowlist } from "../../src/auth/accounts.js";
import { createProvider, type ProviderId } from "../../src/auth/providers.js";
import { cookieNames, csrfToken } from "../../src/auth/sessions.js";
import { buildApp } from "../../src/http/app.js";
import { logSerializers } from "../../src/infra/logging.js";
import type { AuthRuntime } from "../../src/http/routes/auth.js";
import { StubOAuthServer, type StubIdentity } from "./oauth-provider.js";
import { TestClock, createTenant, makeContext, resetData, setupDatabase } from "./harness.js";

/*
 * Dashboard sign-in through the real API routes, against a local OAuth server that
 * enforces client authentication, PKCE S256, single-use codes and redirect URIs
 * (oauth-provider.ts, test infrastructure). Real Google/GitHub sign-in is verified
 * separately (ADR-018).
 */

const APP = "http://localhost:3000";
const HOUR = 3_600_000;

let h: DbHandle;
let stub: StubOAuthServer;
let clock: TestClock;
let app: FastifyInstance;
let auth: AuthRuntime;

beforeAll(async () => {
  h = await setupDatabase();
  stub = new StubOAuthServer();
  await stub.start();
});
afterAll(async () => {
  await app?.close();
  await stub?.close();
  await h?.close();
});

async function makeApp(over: Partial<AuthRuntime> & { allow?: string; any?: boolean; secure?: boolean; timeoutMs?: number; logLines?: string[] } = {}) {
  await app?.close();
  const provider = (id: ProviderId) =>
    createProvider(id, {
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
      redirectUri: `${APP}/api/auth/${id}/callback`,
      endpoints: stub.endpoints(id),
      timeoutMs: over.timeoutMs ?? 2_000,
    });
  auth = {
    appUrl: APP,
    providers: new Map([
      ["google", provider("google")],
      ["github", provider("github")],
    ]),
    allowlist: parseAllowlist(over.allow ?? "@example.com", over.any ?? false),
    policy: { secret: "s".repeat(40), ttlMs: 1 * HOUR, absoluteTtlMs: 3 * HOUR, secureCookies: over.secure ?? false },
    ...over,
  };
  const ctx = makeContext(h, clock);
  if (over.logLines) {
    const lines = over.logLines;
    ctx.log = pino({ serializers: logSerializers }, new Writable({ write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()) }));
  }
  app = await buildApp({ config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [APP], NODE_ENV: "test", LOG_LEVEL: "info" }, ctx, auth });
}

beforeEach(async () => {
  await resetData(h);
  stub.hangTokenEndpoint = false;
  stub.tokenRequests.length = 0;
  clock = new TestClock();
  await makeApp();
});

/** Cookies from Set-Cookie headers: name -> { value, attributes }. */
function cookiesOf(res: LightMyRequestResponse) {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Object.fromEntries(
    list.map((c) => {
      const [pair, ...attrs] = c.split(";").map((s) => s.trim());
      const i = pair!.indexOf("=");
      return [pair!.slice(0, i), { value: decodeURIComponent(pair!.slice(i + 1)), attrs: attrs.map((a) => a.toLowerCase()) }];
    }),
  );
}
const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");

/** Browser sign-in: start, approve at the provider, follow the callback. */
async function signIn(provider: ProviderId, identity: StubIdentity, returnTo?: string) {
  const start = await app.inject({ method: "GET", url: `/auth/${provider}/start${returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}` });
  expect(start.statusCode).toBe(302);
  const stateCookie = cookiesOf(start)[cookieNames(false).state]!.value;
  const authorize = new URL(start.headers.location as string);
  const code = stub.approve(authorize.toString(), identity);
  const callbackUrl = `/auth/${provider}/callback?code=${code}&state=${authorize.searchParams.get("state")}`;
  const callback = await app.inject({ method: "GET", url: callbackUrl, headers: { cookie: cookieHeader({ [cookieNames(false).state]: stateCookie }) } });
  const set = cookiesOf(callback);
  const jar: Record<string, string> = {};
  for (const [k, v] of Object.entries(set)) if (v.value) jar[k] = v.value;
  return { start, authorize, callback, callbackUrl, stateCookie, set, jar, location: callback.headers.location as string };
}

const me = (jar: Record<string, string>) => app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieHeader(jar) } });
const ada: StubIdentity = { sub: "1001", email: "Ada@Example.com", name: "Ada" };

describe("OAuth authorization-code flow with PKCE", () => {
  it("signs in with Google: PKCE verified, first-party cookies, a private workspace, API access", async () => {
    const r = await signIn("google", ada);
    // The authorization request: S256 challenge, our callback on the web app's origin, minimal scopes.
    expect(r.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.authorize.searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/google/callback`);
    expect(r.authorize.searchParams.get("scope")).toBe("openid email profile");
    expect(r.authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The provider saw client authentication and the matching PKCE verifier.
    expect(stub.tokenRequests).toEqual([{ verifierMatched: true, basicAuth: true }]);

    expect(r.location).toBe(`${APP}/dashboard`);
    const names = cookieNames(false);
    expect(r.set[names.session]!.attrs).toEqual(expect.arrayContaining(["httponly", "samesite=lax", "path=/"]));
    expect(r.set[names.csrf]!.attrs).not.toContain("httponly"); // the web app reads it
    expect(r.set[names.state]!.value).toBe(""); // state cookie cleared: single use

    const m = await me(r.jar);
    expect(m.statusCode).toBe(200);
    const body = m.json();
    expect(body.user).toMatchObject({ email: "ada@example.com", name: "Ada" });
    expect(body.workspace).toMatchObject({ role: "owner", name: "Ada's workspace" });
    expect(body.workspaces).toHaveLength(1);
    expect(body.csrfToken).toBe(r.jar[names.csrf]);

    // The session authenticates the API for its workspace.
    const runs = await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(r.jar) } });
    expect(runs.statusCode).toBe(200);
    // Only a hash of the token is stored.
    const [row] = await h.db.select().from(schema.sessions);
    expect(row!.id).not.toBe(r.jar[names.session]);
    expect(row!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs in with GitHub using the primary verified email", async () => {
    const r = await signIn("github", { sub: "77", email: "grace@example.com", name: "Grace", otherEmails: [{ email: "old@example.com", primary: false, verified: true }] });
    expect(r.location).toBe(`${APP}/dashboard`);
    expect((await me(r.jar)).json().user.email).toBe("grace@example.com");
  });

  it("returns to a same-site path and never to another site", async () => {
    expect((await signIn("google", ada, "/dashboard/runs?state=failed")).location).toBe(`${APP}/dashboard/runs?state=failed`);
    for (const evil of ["//evil.example", "https://evil.example/x", "/\\evil.example", "evil.example", "/x\nLocation: //evil"]) {
      expect((await signIn("google", ada, evil)).location, evil).toBe(`${APP}/dashboard`);
    }
  });

  it("links a second provider to the same user by verified email, and keeps different people apart", async () => {
    const g = await signIn("google", ada);
    const gh = await signIn("github", { sub: "42", email: "ada@example.com", name: "Ada L." });
    const other = await signIn("github", { sub: "43", email: "bob@example.com", name: "Bob" });
    const [a, b, c] = await Promise.all([me(g.jar), me(gh.jar), me(other.jar)].map(async (p) => (await p).json()));
    expect(b.user.id).toBe(a.user.id);
    expect(b.workspace.id).toBe(a.workspace.id);
    expect(c.user.id).not.toBe(a.user.id);
    expect(c.workspace.id).not.toBe(a.workspace.id);
    expect(await h.db.select().from(schema.oauthAccounts)).toHaveLength(3);
    expect(await h.db.select().from(schema.users)).toHaveLength(2);
  });
});

describe("sign-in refusals", () => {
  const errorOf = (location: string) => new URL(location).searchParams.get("error");

  it("rejects a callback without, with a tampered, an expired or another provider's state", async () => {
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const cookie = cookiesOf(start)[cookieNames(false).state]!.value;
    const code = stub.approve(start.headers.location as string, ada);
    const call = async (path: string, value?: string) =>
      errorOf(
        (await app.inject({ method: "GET", url: path, headers: value ? { cookie: cookieHeader({ [cookieNames(false).state]: value }) } : {} })).headers
          .location as string,
      );
    expect(await call(`/auth/google/callback?code=${code}&state=${state}`)).toBe("invalid_state");
    expect(await call(`/auth/google/callback?code=${code}&state=${state}`, cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBe("invalid_state");
    expect(await call(`/auth/google/callback?code=${code}&state=other`, cookie)).toBe("invalid_state");
    expect(await call(`/auth/github/callback?code=${code}&state=${state}`, cookie)).toBe("invalid_state");
    clock.advance(11 * 60_000);
    expect(await call(`/auth/google/callback?code=${code}&state=${state}`, cookie)).toBe("invalid_state");
    expect(stub.tokenRequests).toHaveLength(0); // nothing reached the provider
    expect(await h.db.select().from(schema.sessions)).toHaveLength(0);
  });

  it("maps a declined consent, a replayed code, unverified emails and the allowlist to clear errors", async () => {
    expect(errorOf((await app.inject({ method: "GET", url: "/auth/google/callback?error=access_denied&state=x" })).headers.location as string)).toBe("cancelled");
    expect(errorOf((await signIn("google", { ...ada, emailVerified: false })).location)).toBe("email_unverified");
    expect(errorOf((await signIn("github", { sub: "9", email: "x@example.com", emailVerified: false })).location)).toBe("email_unverified");
    expect(errorOf((await signIn("google", { sub: "5", email: "eve@elsewhere.org" })).location)).toBe("not_allowed");

    // A code can be exchanged once: replaying the whole callback fails at the provider.
    const r = await signIn("google", ada);
    const replay = await app.inject({ method: "GET", url: r.callbackUrl, headers: { cookie: cookieHeader({ [cookieNames(false).state]: r.stateCookie }) } });
    expect(errorOf(replay.headers.location as string)).toBe("provider_error");
    expect(await h.db.select().from(schema.users)).toHaveLength(1); // only ada
  });

  it("logs a refused sign-in by email domain and fingerprint, never the address", async () => {
    const lines: string[] = [];
    await makeApp({ logLines: lines });
    expect(errorOf((await signIn("google", { sub: "5", email: "Eve.Private@Elsewhere.org" })).location)).toBe("not_allowed");
    const refused = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "sign-in refused");
    expect(refused).toMatchObject({ code: "not_allowed", emailDomain: "elsewhere.org", emailHash: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(lines.join("").toLowerCase()).not.toContain("eve.private");
  });

  it("an empty allowlist lets nobody in; AUTH_ALLOW_ANY_EMAIL lets any verified email in", async () => {
    await makeApp({ allow: "" });
    expect(errorOf((await signIn("google", ada)).location)).toBe("not_allowed");
    await makeApp({ allow: "", any: true });
    expect((await signIn("google", { sub: "5", email: "eve@elsewhere.org" })).location).toBe(`${APP}/dashboard`);
  });

  it("bounds a provider that never answers, and rate-limits sign-in attempts per client", async () => {
    await makeApp({ timeoutMs: 300 });
    stub.hangTokenEndpoint = true;
    const t0 = performance.now();
    expect(errorOf((await signIn("google", ada)).location)).toBe("unavailable");
    expect(performance.now() - t0).toBeLessThan(2_000);

    await makeApp({ signInPerMinute: 3 });
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) codes.push(errorOf((await app.inject({ method: "GET", url: "/auth/google/start" })).headers.location as string) ?? "redirected");
    expect(codes).toEqual(["redirected", "redirected", "redirected", "rate_limited"]);
  });

  it("reports which providers are configured, and refuses unknown or unconfigured ones", async () => {
    await makeApp({ providers: new Map() });
    expect((await app.inject({ method: "GET", url: "/auth/providers" })).json()).toEqual({
      providers: [
        { id: "google", configured: false },
        { id: "github", configured: false },
      ],
    });
    expect(errorOf((await app.inject({ method: "GET", url: "/auth/google/start" })).headers.location as string)).toBe("not_configured");
    expect(errorOf((await app.inject({ method: "GET", url: "/auth/myspace/start" })).headers.location as string)).toBe("unknown_provider");
  });
});

describe("sessions", () => {
  it("require the CSRF token for writes; API keys do not", async () => {
    const r = await signIn("google", ada);
    const csrf = r.jar[cookieNames(false).csrf]!;
    const put = (headers: Record<string, string>) =>
      app.inject({ method: "PUT", url: "/v1/workflows", headers: { cookie: cookieHeader(r.jar), ...headers }, payload: { name: "wf", tasks: [{ key: "a", type: "t" }] } });
    expect((await put({})).json().error.code).toBe("csrf_failed");
    expect((await put({ "x-csrf-token": "x".repeat(43) })).statusCode).toBe(403);
    const other = await signIn("google", { sub: "2", email: "bob@example.com" });
    expect((await put({ "x-csrf-token": other.jar[cookieNames(false).csrf]! })).statusCode).toBe(403);
    expect((await put({ "x-csrf-token": csrf })).statusCode).toBe(201);
  });

  it("are confined to the active workspace, and viewers cannot write", async () => {
    const a = await signIn("google", ada);
    const b = await signIn("google", { sub: "2", email: "bob@example.com" });
    const csrfB = b.jar[cookieNames(false).csrf]!;
    const created = await app.inject({
      method: "PUT",
      url: "/v1/workflows",
      headers: { cookie: cookieHeader(b.jar), "x-csrf-token": csrfB },
      payload: { name: "bobs", tasks: [{ key: "a", type: "t" }] },
    });
    expect(created.statusCode).toBe(201);
    // Ada cannot see Bob's workflow.
    expect((await app.inject({ method: "GET", url: "/v1/workflows/bobs", headers: { cookie: cookieHeader(a.jar) } })).statusCode).toBe(404);

    // Ada joins Bob's workspace as a viewer and switches to it: read yes, write no.
    const [adaUser] = await h.db.select().from(schema.users).where(sql`email = 'ada@example.com'`);
    const bobWs = (await me(b.jar)).json().workspace.id as string;
    await h.db.insert(schema.memberships).values({ tenantId: bobWs, userId: adaUser!.id, role: "viewer", createdAt: clock.now() });
    const csrfA = a.jar[cookieNames(false).csrf]!;
    const sw = await app.inject({ method: "POST", url: "/auth/workspace", headers: { cookie: cookieHeader(a.jar), "x-csrf-token": csrfA }, payload: { tenantId: bobWs } });
    expect(sw.statusCode).toBe(200);
    expect((await me(a.jar)).json()).toMatchObject({ workspace: { id: bobWs, role: "viewer" }, workspaces: expect.any(Array) });
    expect((await app.inject({ method: "GET", url: "/v1/workflows/bobs", headers: { cookie: cookieHeader(a.jar) } })).statusCode).toBe(200);
    const write = await app.inject({
      method: "PUT",
      url: "/v1/workflows",
      headers: { cookie: cookieHeader(a.jar), "x-csrf-token": csrfA },
      payload: { name: "nope", tasks: [{ key: "a", type: "t" }] },
    });
    expect(write.statusCode).toBe(403);

    // Switching to a workspace you are not a member of looks like it does not exist.
    const stranger = await createTenant(h, "stranger");
    const denied = await app.inject({ method: "POST", url: "/auth/workspace", headers: { cookie: cookieHeader(b.jar), "x-csrf-token": csrfB }, payload: { tenantId: stranger } });
    expect(denied.statusCode).toBe(404);
    // Removing the membership ends API access through that session.
    await h.db.delete(schema.memberships).where(eq(schema.memberships.userId, adaUser!.id));
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(a.jar) } })).statusCode).toBe(401);
  });

  it("slide with use, never past the absolute lifetime, and expire when idle", async () => {
    const r = await signIn("google", ada);
    const expiry = async () => new Date((await me(r.jar)).json().sessionExpiresAt).getTime();
    const first = await expiry();
    expect(first).toBe(clock.now().getTime() + HOUR);
    for (let i = 0; i < 4; i++) {
      clock.advance(40 * 60_000); // used every 40 minutes: renewed each time
      expect(await expiry()).toBe(Math.min(clock.now().getTime() + HOUR, first - HOUR + 3 * HOUR));
    }
    clock.advance(30 * 60_000); // 3h10m after sign-in: past the absolute cap
    expect((await me(r.jar)).statusCode).toBe(401);

    const idle = await signIn("google", ada);
    clock.advance(HOUR + 1_000);
    expect((await me(idle.jar)).statusCode).toBe(401);
  });

  it("log out: CSRF required, session deleted, cookies cleared", async () => {
    const r = await signIn("google", ada);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: cookieHeader(r.jar) } })).statusCode).toBe(403);
    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: cookieHeader(r.jar), "x-csrf-token": r.jar[cookieNames(false).csrf]! } });
    expect(out.statusCode).toBe(204);
    expect(cookiesOf(out)[cookieNames(false).session]!.value).toBe("");
    expect(await h.db.select().from(schema.sessions)).toHaveLength(0);
    expect((await me(r.jar)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(r.jar) } })).statusCode).toBe(401);
  });

  it("a user pre-provisioned with flowforge-admin add-member lands in that workspace on first sign-in", async () => {
    await createTenant(h, "acme");
    await h.db.insert(schema.users).values({ email: "ada@example.com" });
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { TEST_URL } = await import("./harness.js");
    const admin = fileURLToPath(new URL("../../dist/admin.js", import.meta.url));
    const run = (...a: string[]) => spawnSync(process.execPath, [admin, ...a], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_URL }, encoding: "utf8" });
    expect(run("add-member", "acme", "Ada@Example.com", "admin").stdout).toBe("ada@example.com is admin of acme\n");
    expect(run("add-member", "acme", "not-an-email", "admin").status).toBe(1);
    expect(run("add-member", "acme", "x@example.com", "root").status).toBe(1);
    const r = await signIn("github", { sub: "555", email: "ada@example.com", name: "Ada" });
    expect((await me(r.jar)).json().workspace).toMatchObject({ slug: "acme", role: "admin" });
    expect(await h.db.select().from(schema.users)).toHaveLength(1); // linked, not duplicated
  });

  it("end on their next use once the email is taken off the allowlist", async () => {
    const r = await signIn("google", ada);
    expect((await me(r.jar)).statusCode).toBe(200);
    await makeApp({ allow: "bob@example.com" }); // the operator narrows AUTH_ALLOWED_EMAILS and restarts
    expect((await me(r.jar)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(r.jar) } })).statusCode).toBe(401);
    expect(await h.db.select().from(schema.sessions)).toHaveLength(0);
  });

  it("use __Host- cookies with Secure on https deployments", async () => {
    await makeApp({ secure: true });
    const start = await app.inject({ method: "GET", url: "/auth/google/start" });
    const state = cookiesOf(start)["__Host-ff_oauth"]!;
    expect(state.attrs).toEqual(expect.arrayContaining(["secure", "httponly", "path=/"]));
    expect(cookieNames(true)).toEqual({ session: "__Host-ff_session", csrf: "__Host-ff_csrf", state: "__Host-ff_oauth" });
    expect(csrfToken("k", "a")).not.toBe(csrfToken("k", "b"));
  });
});

describe("removing access", () => {
  const bob: StubIdentity = { sub: "2002", email: "bob@example.com", name: "Bob" };
  const cara: StubIdentity = { sub: "3003", email: "cara@example.com", name: "Cara" };
  const write = (jar: Record<string, string>, method: "DELETE" | "POST", url: string) =>
    app.inject({ method, url, headers: { cookie: cookieHeader(jar), "x-csrf-token": jar[cookieNames(false).csrf]! } });

  /** Ada owns a workspace; Bob is a member of it and is working in it. */
  async function team(bobRole: "member" | "admin" | "owner" = "member") {
    const a = await signIn("google", ada);
    const b = await signIn("google", bob);
    const tenantId = (await me(a.jar)).json().workspace.id as string;
    const bobId = (await me(b.jar)).json().user.id as string;
    await h.db.insert(schema.memberships).values({ tenantId, userId: bobId, role: bobRole, createdAt: clock.now() });
    expect((await app.inject({ method: "POST", url: "/auth/workspace", headers: { cookie: cookieHeader(b.jar), "x-csrf-token": b.jar[cookieNames(false).csrf]! }, payload: { tenantId } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(b.jar) } })).statusCode).toBe(200);
    return { a, b, tenantId, bobId, adaId: (await me(a.jar)).json().user.id as string };
  }

  it("an owner removes a member: the member's next request fails and their sessions in it end", async () => {
    const { a, b, tenantId, bobId } = await team();
    const res = await write(a.jar, "DELETE", `/v1/members/${bobId}`);
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(b.jar) } })).statusCode).toBe(401);
    expect((await me(b.jar)).statusCode).toBe(401);
    const left = await h.db.select().from(schema.memberships).where(eq(schema.memberships.tenantId, tenantId));
    expect(left.map((m) => m.userId)).not.toContain(bobId);
    // Bob's own workspace is untouched: he can sign in again and use it.
    const again = await signIn("google", bob);
    expect((await me(again.jar)).json().workspace.role).toBe("owner");
    expect((await write(a.jar, "DELETE", `/v1/members/${bobId}`)).statusCode).toBe(404);
  });

  it("keeps the last owner, stops admins removing owners, and refuses members, viewers and API keys", async () => {
    const { a, b, adaId, bobId } = await team("admin");
    expect((await write(a.jar, "DELETE", `/v1/members/${adaId}`)).json().error.code).toBe("last_owner");
    expect((await write(b.jar, "DELETE", `/v1/members/${adaId}`)).statusCode).toBe(403);
    await h.db.update(schema.memberships).set({ role: "member" }).where(eq(schema.memberships.userId, bobId));
    expect((await write(b.jar, "DELETE", `/v1/members/${adaId}`)).statusCode).toBe(403);
    const c = await signIn("google", cara);
    expect((await write(c.jar, "DELETE", `/v1/members/${bobId}`)).statusCode).toBe(404); // not in Cara's workspace
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${bobId}` })).statusCode).toBe(401);
  });

  it("flowforge-admin remove-member and revoke-sessions end access from the command line", async () => {
    const { a, b, bobId } = await team();
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { TEST_URL } = await import("./harness.js");
    const admin = fileURLToPath(new URL("../../dist/admin.js", import.meta.url));
    const run = (...args: string[]) => spawnSync(process.execPath, [admin, ...args], { env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_URL }, encoding: "utf8" });
    const slug = (await me(a.jar)).json().workspace.slug as string;

    const removed = run("remove-member", slug, "Bob@Example.com");
    expect(removed.stdout).toBe(`removed bob@example.com from ${slug}; ended 1 session(s)\n`);
    expect((await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie: cookieHeader(b.jar) } })).statusCode).toBe(401);
    expect(run("remove-member", slug, "bob@example.com").status).toBe(1);
    expect(run("remove-member", slug, "ada@example.com").stderr).toMatch(/last owner/);

    expect(run("revoke-sessions", "ada@example.com").stdout).toBe("ended 1 session(s) of ada@example.com\n");
    expect((await me(a.jar)).statusCode).toBe(401);
    expect(run("revoke-sessions", "nobody@example.com").status).toBe(1);
    expect(bobId).toBeTruthy();
  });
});
