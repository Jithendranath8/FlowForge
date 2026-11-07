import { schema } from "@flowforge/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { looksLikeApiKey, sha256, type Scope } from "../auth/tokens.js";
import { forbidden, rateLimited, unauthorized } from "../errors.js";
import type { EngineContext } from "../engine/context.js";
import type { FixedWindowLimiter, LimitResult } from "./limits.js";
import { clientKey } from "./limits.js";

export type Principal =
  | { kind: "api_key"; tenantId: string; keyId: string; scopes: Scope[]; label: string }
  | { kind: "user"; tenantId: string; userId: string; role: "owner" | "admin" | "member" | "viewer"; label: string; sessionId?: string };

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Role -> scopes for dashboard users. Viewers are read-only. */
const ROLE_SCOPES: Record<string, Scope[]> = {
  owner: ["read", "workflows:write", "runs:write"],
  admin: ["read", "workflows:write", "runs:write"],
  member: ["read", "workflows:write", "runs:write"],
  viewer: ["read"],
};

export type SessionResolver = (req: FastifyRequest) => Promise<Principal | null>;

export interface AuthLimits {
  /** Failed authentication attempts, keyed by client IP. */
  authFailures: FixedWindowLimiter;
  /** Authenticated requests, keyed by credential (API key id or user id). */
  perCredential: FixedWindowLimiter;
  /** Authenticated requests, keyed by tenant across all its credentials. */
  perTenant: FixedWindowLimiter;
}

/**
 * Resolve the caller from `Authorization: Bearer ffk_…` (SDK / workers) or, if a
 * session resolver is installed, from the session cookie (dashboard).
 *
 * Abuse controls, in order:
 *  1. A client IP over its failed-authentication budget is refused before any database
 *     work, so guessing keys cannot generate unbounded api_keys lookups.
 *  2. Every failed attempt (missing, malformed, unknown, revoked or expired credential)
 *     counts against that budget.
 *  3. After success, requests count against the authenticated credential and its tenant.
 *     Keys come from the principal, never from header text, so header spelling
 *     variants cannot open new buckets.
 */
export function makeAuthenticate(ctx: EngineContext, limits?: AuthLimits, resolveSession?: SessionResolver) {
  const fail = (req: FastifyRequest) => {
    limits?.authFailures.hit(clientKey(req.ip));
    return unauthorized();
  };
  return async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (limits) {
      // AUTH_FAILURE_LIMIT failures are allowed per window; the next attempt is refused.
      const f = limits.authFailures.peek(clientKey(req.ip));
      if (f.remaining === 0) throw rateLimited("auth_rate_limited", "Too many failed authentication attempts", f.resetMs);
    }
    let principal: Principal | null;
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m || !looksLikeApiKey(m[1]!)) throw fail(req);
      const now = ctx.now();
      const [key] = await ctx.db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.hash, sha256(m[1]!)), isNull(schema.apiKeys.revokedAt)));
      if (!key || (key.expiresAt && key.expiresAt.getTime() <= now.getTime())) throw fail(req);
      // Throttled last-used tracking (at most once a minute per key).
      if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
        await ctx.db.update(schema.apiKeys).set({ lastUsedAt: now }).where(eq(schema.apiKeys.id, key.id));
      }
      principal = { kind: "api_key", tenantId: key.tenantId, keyId: key.id, scopes: key.scopes as Scope[], label: `api_key:${key.prefix}` };
    } else {
      principal = resolveSession ? await resolveSession(req) : null;
      if (!principal) throw fail(req);
    }
    req.principal = principal;
    if (limits) enforceRequestLimits(limits, principal, reply);
  };
}

function enforceRequestLimits(limits: AuthLimits, p: Principal, reply: FastifyReply) {
  const credential = limits.perCredential.hit(p.kind === "api_key" ? `k:${p.keyId}` : `u:${p.userId}`);
  const tenant = limits.perTenant.hit(`t:${p.tenantId}`);
  // Advertise whichever budget is closer to exhaustion.
  const binding: LimitResult = tenant.remaining < credential.remaining ? tenant : credential;
  reply.header("x-ratelimit-limit", String(binding.limit));
  reply.header("x-ratelimit-remaining", String(binding.remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(binding.resetMs / 1000)));
  if (!credential.allowed) throw rateLimited("rate_limited", "Rate limit exceeded for this credential", credential.resetMs, { scope: "credential" });
  if (!tenant.allowed) throw rateLimited("rate_limited", "Rate limit exceeded for this tenant", tenant.resetMs, { scope: "tenant" });
}

/** Whether a principal holds a scope (API keys by their scopes, users by their role). */
export function hasScope(p: Principal | undefined, scope: Scope): boolean {
  if (!p) return false;
  const scopes = p.kind === "api_key" ? p.scopes : (ROLE_SCOPES[p.role] ?? []);
  return scopes.includes(scope);
}

export function requireScope(req: FastifyRequest, scope: Scope): Principal {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (!hasScope(p, scope)) throw forbidden(`Missing scope ${scope}`);
  return p;
}

/**
 * Actions only a signed-in workspace owner or admin may take (managing API keys). API
 * keys never qualify, so a leaked key cannot mint more keys.
 */
export function requireRole(req: FastifyRequest, roles: readonly ("owner" | "admin" | "member" | "viewer")[]): Extract<Principal, { kind: "user" }> {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (p.kind !== "user") throw forbidden("Requires a signed-in user; API keys cannot do this");
  if (!roles.includes(p.role)) throw forbidden(`Requires the ${roles.join(" or ")} role`);
  return p;
}
