import { createHmac } from "node:crypto";
import { schema, type Database } from "@flowforge/db";
import { eq } from "drizzle-orm";
import { generateSessionToken, safeEqual, sha256 } from "./tokens.js";

/*
 * Dashboard sessions (ADR-018).
 *
 * - The browser holds an opaque random token (32 bytes) in an HttpOnly cookie; the
 *   database stores only its SHA-256, so a database leak yields no usable session.
 * - Expiry slides: each use (at most one write per RENEW_EVERY_MS) pushes the expiry to
 *   now + ttl, never past createdAt + absoluteTtl. Sign-in always creates a new session.
 * - CSRF: unsafe requests must send `x-csrf-token` = HMAC(secret, session id). The value
 *   is also set in a JS-readable cookie for the web app. Cookies are SameSite=Lax and the
 *   API refuses cross-origin writes, so this is defence in depth.
 * - OAuth state, PKCE verifier and return path travel in a signed, 10-minute,
 *   single-use HttpOnly cookie.
 * Times come from the engine clock (ADR-015).
 */

export interface SessionPolicy {
  secret: string;
  /** Sliding lifetime. */
  ttlMs: number;
  /** Hard cap from creation. */
  absoluteTtlMs: number;
  /** `Secure` cookies with the `__Host-` prefix (https deployments). */
  secureCookies: boolean;
}

export const RENEW_EVERY_MS = 5 * 60_000;
export const STATE_TTL_MS = 10 * 60_000;

export function cookieNames(secure: boolean) {
  const p = secure ? "__Host-" : "";
  return { session: `${p}ff_session`, csrf: `${p}ff_csrf`, state: `${p}ff_oauth` };
}

const hmac = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("base64url");

export const csrfToken = (secret: string, sessionId: string) => hmac(secret, `csrf:${sessionId}`);

export interface SessionRecord {
  id: string;
  userId: string;
  activeTenantId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function createSession(
  db: Database,
  now: Date,
  policy: SessionPolicy,
  input: { userId: string; tenantId: string; userAgent?: string | undefined },
): Promise<{ token: string; session: SessionRecord; csrf: string }> {
  const { token, id } = generateSessionToken();
  const expiresAt = new Date(now.getTime() + Math.min(policy.ttlMs, policy.absoluteTtlMs));
  const [row] = await db
    .insert(schema.sessions)
    .values({ id, userId: input.userId, activeTenantId: input.tenantId, createdAt: now, expiresAt, lastSeenAt: now, userAgent: input.userAgent?.slice(0, 300) ?? null })
    .returning();
  return { token, session: row!, csrf: csrfToken(policy.secret, id) };
}

/** The live session for a cookie value, renewing its expiry; null if unknown or expired. */
export async function lookupSession(db: Database, now: Date, policy: SessionPolicy, token: string | undefined): Promise<SessionRecord | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  if (!s || s.expiresAt.getTime() <= now.getTime()) return null;
  const capped = Math.min(now.getTime() + policy.ttlMs, s.createdAt.getTime() + policy.absoluteTtlMs);
  if (now.getTime() - s.lastSeenAt.getTime() >= RENEW_EVERY_MS && capped > s.expiresAt.getTime()) {
    const expiresAt = new Date(capped);
    await db.update(schema.sessions).set({ expiresAt, lastSeenAt: now }).where(eq(schema.sessions.id, s.id));
    return { ...s, expiresAt };
  }
  return s;
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}

export interface OAuthState {
  /** Provider id. */
  p: string;
  /** OAuth `state` value. */
  s: string;
  /** PKCE code verifier. */
  v: string;
  /** Validated same-site return path. */
  r: string;
  /** Expiry, epoch ms (engine clock). */
  exp: number;
}

export function signState(secret: string, state: Omit<OAuthState, "exp">, now: Date): string {
  const body = Buffer.from(JSON.stringify({ ...state, exp: now.getTime() + STATE_TTL_MS })).toString("base64url");
  return `${body}.${hmac(secret, `state:${body}`)}`;
}

export function verifyState(secret: string, value: string | undefined, now: Date): OAuthState | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), hmac(secret, `state:${body}`))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.exp !== "number" || s.exp <= now.getTime()) return null;
    if (![s.p, s.s, s.v, s.r].every((x) => typeof x === "string" && x.length > 0)) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * A return path after sign-in: only same-site paths, so the callback can never redirect
 * elsewhere (no scheme, no `//host`, no backslashes, no control characters).
 */
export function safeReturnTo(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  return value;
}
