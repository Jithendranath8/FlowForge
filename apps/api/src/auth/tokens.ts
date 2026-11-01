import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** API keys look like `ffk_<8 char id>_<43 char secret>`; only the SHA-256 is stored. */
export const API_KEY_PREFIX = "ffk_";

export const SCOPES = ["workflows:write", "runs:write", "read", "worker"] as const;
export type Scope = (typeof SCOPES)[number];

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const id = randomBytes(6).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const key = `${API_KEY_PREFIX}${id}_${secret}`;
  return { key, prefix: `${API_KEY_PREFIX}${id}`, hash: sha256(key) };
}

export function generateSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, id: sha256(token) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function looksLikeApiKey(value: string): boolean {
  return /^ffk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/.test(value);
}
