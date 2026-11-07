import { schema } from "@flowforge/db";
import { generateCodeVerifier, generateState } from "arctic";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isAllowed, signInIdentity, workspacesOf, type EmailAllowlist } from "../../auth/accounts.js";
import { PROVIDER_IDS, SignInError, type OAuthProvider, type ProviderId } from "../../auth/providers.js";
import {
  cookieNames,
  createSession,
  csrfToken,
  lookupSession,
  revokeSession,
  safeReturnTo,
  signState,
  verifyState,
  type SessionPolicy,
  type SessionRecord,
} from "../../auth/sessions.js";
import { safeEqual } from "../../auth/tokens.js";
import type { EngineContext } from "../../engine/context.js";
import { AppError, unauthorized } from "../../errors.js";
import type { Principal, SessionResolver } from "../auth.js";
import { clientKey, FixedWindowLimiter } from "../limits.js";

/*
 * Browser sign-in (ADR-018). Mounted at /auth on the API; the web app forwards
 * /api/auth/* here, so every redirect and cookie is on the web app's origin.
 */

export interface AuthRuntime {
  policy: SessionPolicy;
  /** Origin of the web app: the only redirect target (plus a validated path). */
  appUrl: string;
  providers: ReadonlyMap<ProviderId, OAuthProvider>;
  allowlist: EmailAllowlist;
  /** Sign-in starts and callbacks per client IP per minute. */
  signInPerMinute?: number;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const csrfFailed = () => new AppError(403, "csrf_failed", "Missing or invalid x-csrf-token header");

/**
 * Resolves the dashboard session behind a request, for /v1 and /auth/me. Unsafe
 * methods must carry the session's CSRF token. A session whose active workspace
 * membership is gone resolves to nothing.
 */
export function makeSessionResolver(ctx: EngineContext, auth: AuthRuntime): SessionResolver & { session(req: FastifyRequest): Promise<SessionRecord | null> } {
  const names = cookieNames(auth.policy.secureCookies);
  /**
   * The request's session, if it is valid and its user is still allowed to sign in: a
   * session whose email has been taken off AUTH_ALLOWED_EMAILS ends on its next use.
   */
  const session = async (req: FastifyRequest): Promise<SessionRecord | null> => {
    const s = await lookupSession(ctx.db, ctx.now(), auth.policy, req.cookies[names.session]);
    if (!s || auth.allowlist.any) return s;
    const [u] = await ctx.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, s.userId));
    if (u?.email && isAllowed(auth.allowlist, u.email)) return s;
    await revokeSession(ctx.db, s.id);
    req.log.info({ userId: s.userId }, "session ended: the user is no longer allowed to sign in");
    return null;
  };
  const resolver = async (req: FastifyRequest): Promise<Principal | null> => {
    const s = await session(req);
    if (!s || !s.activeTenantId) return null;
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, csrfToken(auth.policy.secret, s.id))) throw csrfFailed();
    }
    const [m] = await ctx.db
      .select({ role: schema.memberships.role, email: schema.users.email })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.userId, s.userId), eq(schema.memberships.tenantId, s.activeTenantId)));
    if (!m) return null;
    return { kind: "user", tenantId: s.activeTenantId, userId: s.userId, role: m.role, label: `user:${m.email ?? s.userId}`, sessionId: s.id };
  };
  return Object.assign(resolver, { session });
}

const WorkspaceBody = z.object({ tenantId: z.uuid() });
const ProviderParams = z.object({ provider: z.enum(PROVIDER_IDS) });

export function authRoutes(app: FastifyInstance, ctx: EngineContext, auth: AuthRuntime, resolver: ReturnType<typeof makeSessionResolver>) {
  const names = cookieNames(auth.policy.secureCookies);
  const cookie = { path: "/", httpOnly: true, secure: auth.policy.secureCookies, sameSite: "lax" as const };
  const limiter = new FixedWindowLimiter({ limit: auth.signInPerMinute ?? 30, windowMs: 60_000 });
  const toApp = (reply: FastifyReply, path: string) => reply.redirect(`${auth.appUrl}${path}`, 302);
  const signInError = (reply: FastifyReply, code: string) => {
    reply.clearCookie(names.state, cookie);
    return toApp(reply, `/sign-in?error=${encodeURIComponent(code)}`);
  };

  /** Which providers this deployment has credentials for (the sign-in page shows the rest as not configured). */
  app.get("/auth/providers", async () => ({ providers: PROVIDER_IDS.map((id) => ({ id, configured: auth.providers.has(id) })) }));

  app.get("/auth/:provider/start", async (req, reply) => {
    const parsed = ProviderParams.safeParse(req.params);
    if (!parsed.success) return signInError(reply, "unknown_provider");
    const provider = auth.providers.get(parsed.data.provider);
    if (!provider) return signInError(reply, "not_configured");
    if (!limiter.hit(clientKey(req.ip)).allowed) return signInError(reply, "rate_limited");
    const state = generateState();
    const verifier = generateCodeVerifier();
    const returnTo = safeReturnTo((req.query as Record<string, unknown>).returnTo);
    reply.setCookie(names.state, signState(auth.policy.secret, { p: provider.id, s: state, v: verifier, r: returnTo }, ctx.now()), { ...cookie, maxAge: 600 });
    return reply.redirect(provider.authorizationUrl(state, verifier).toString(), 302);
  });

  app.get("/auth/:provider/callback", async (req, reply) => {
    const parsed = ProviderParams.safeParse(req.params);
    const provider = parsed.success ? auth.providers.get(parsed.data.provider) : undefined;
    if (!provider) return signInError(reply, "not_configured");
    if (!limiter.hit(clientKey(req.ip)).allowed) return signInError(reply, "rate_limited");
    const q = req.query as Record<string, unknown>;
    // The user declined, or the provider refused: no code to exchange.
    if (typeof q.error === "string") return signInError(reply, q.error === "access_denied" ? "cancelled" : "provider_error");
    const st = verifyState(auth.policy.secret, req.cookies[names.state], ctx.now());
    if (!st || st.p !== provider.id || typeof q.state !== "string" || !safeEqual(q.state, st.s) || typeof q.code !== "string" || q.code.length > 2048) {
      return signInError(reply, "invalid_state");
    }
    reply.clearCookie(names.state, cookie); // single use
    let signedIn;
    try {
      const identity = await provider.identify(q.code, st.v);
      signedIn = await signInIdentity(ctx.db, ctx.now(), identity, auth.allowlist);
      req.log.info({ provider: provider.id, userId: signedIn.userId, createdUser: signedIn.createdUser }, "signed in");
    } catch (err) {
      if (err instanceof SignInError) {
        req.log.warn({ provider: provider.id, code: err.code, reason: err.message, ...err.details }, "sign-in refused");
        return signInError(reply, err.code);
      }
      req.log.error({ err, provider: provider.id }, "sign-in failed");
      return signInError(reply, "unavailable");
    }
    const { token, session, csrf } = await createSession(ctx.db, ctx.now(), auth.policy, {
      userId: signedIn.userId,
      tenantId: signedIn.tenantId,
      userAgent: req.headers["user-agent"],
    });
    const lastsUntil = new Date(session.createdAt.getTime() + auth.policy.absoluteTtlMs);
    reply.setCookie(names.session, token, { ...cookie, expires: lastsUntil });
    reply.setCookie(names.csrf, csrf, { ...cookie, httpOnly: false, expires: lastsUntil });
    return toApp(reply, st.r);
  });

  /** The signed-in user, their workspaces and the CSRF token for writes. */
  app.get("/auth/me", async (req) => {
    const s = await resolver.session(req);
    if (!s) throw unauthorized();
    const [user] = await ctx.db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, avatarUrl: schema.users.avatarUrl })
      .from(schema.users)
      .where(eq(schema.users.id, s.userId));
    const workspaces = await workspacesOf(ctx.db, s.userId);
    return {
      user,
      workspace: workspaces.find((w) => w.id === s.activeTenantId) ?? null,
      workspaces,
      csrfToken: csrfToken(auth.policy.secret, s.id),
      sessionExpiresAt: s.expiresAt.toISOString(),
    };
  });

  app.post("/auth/workspace", async (req) => {
    const s = await resolver.session(req);
    if (!s) throw unauthorized();
    const header = req.headers["x-csrf-token"];
    if (typeof header !== "string" || !safeEqual(header, csrfToken(auth.policy.secret, s.id))) throw csrfFailed();
    const body = WorkspaceBody.safeParse(req.body);
    if (!body.success) throw new AppError(400, "invalid_request", "tenantId must be a workspace id");
    const workspaces = await workspacesOf(ctx.db, s.userId);
    const target = workspaces.find((w) => w.id === body.data.tenantId);
    // Not a member: indistinguishable from a workspace that does not exist.
    if (!target) throw new AppError(404, "not_found", "Workspace not found");
    await ctx.db.update(schema.sessions).set({ activeTenantId: target.id }).where(eq(schema.sessions.id, s.id));
    return { workspace: target };
  });

  app.post("/auth/logout", async (req, reply) => {
    const s = await resolver.session(req);
    if (s) {
      const header = req.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, csrfToken(auth.policy.secret, s.id))) throw csrfFailed();
      await revokeSession(ctx.db, s.id);
    }
    reply.clearCookie(names.session, cookie);
    reply.clearCookie(names.csrf, { ...cookie, httpOnly: false });
    return reply.code(204).send();
  });
}
