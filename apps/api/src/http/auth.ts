import { schema } from "@flowforge/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { looksLikeApiKey, sha256, type Scope } from "../auth/tokens.js";
import { forbidden, unauthorized } from "../errors.js";
import type { EngineContext } from "../engine/context.js";

export type Principal =
  | { kind: "api_key"; tenantId: string; keyId: string; scopes: Scope[]; label: string }
  | { kind: "user"; tenantId: string; userId: string; role: "owner" | "admin" | "member" | "viewer"; label: string };

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

/**
 * Resolve the caller from `Authorization: Bearer ffk_…` (SDK / workers) or, if a
 * session resolver is installed, from the session cookie (dashboard).
 */
export function makeAuthenticate(ctx: EngineContext, resolveSession?: SessionResolver) {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m || !looksLikeApiKey(m[1]!)) throw unauthorized();
      const now = ctx.now();
      const [key] = await ctx.db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.hash, sha256(m[1]!)), isNull(schema.apiKeys.revokedAt)));
      if (!key || (key.expiresAt && key.expiresAt.getTime() <= now.getTime())) throw unauthorized();
      // Throttled last-used tracking (at most once a minute per key).
      if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
        await ctx.db.update(schema.apiKeys).set({ lastUsedAt: sql`now()` }).where(eq(schema.apiKeys.id, key.id));
      }
      req.principal = { kind: "api_key", tenantId: key.tenantId, keyId: key.id, scopes: key.scopes as Scope[], label: `api_key:${key.prefix}` };
      return;
    }
    const fromSession = resolveSession ? await resolveSession(req) : null;
    if (!fromSession) throw unauthorized();
    req.principal = fromSession;
  };
}

export function requireScope(req: FastifyRequest, scope: Scope): Principal {
  const p = req.principal;
  if (!p) throw unauthorized();
  const scopes = p.kind === "api_key" ? p.scopes : (ROLE_SCOPES[p.role] ?? []);
  if (!scopes.includes(scope)) throw forbidden(`Missing scope ${scope}`);
  return p;
}
