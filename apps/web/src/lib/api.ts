/*
 * Browser calls to the FlowForge API through the web app's /api proxy (same origin, so
 * the HttpOnly session cookie travels by itself). Writes carry the CSRF token the API
 * set in a readable cookie.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The CSRF token for this session, from GET /auth/me (set by the session provider on
 * every dashboard load). It is preferred to the cookie, which is written once at sign-in:
 * if the server's SESSION_SECRET is rotated, the cookie's token no longer matches while
 * /auth/me computes the current one, so writes (and sign-out) keep working.
 */
let sessionCsrf: string | null = null;
export function setSessionCsrf(token: string | null) {
  sessionCsrf = token;
}

export function csrfToken(): string | null {
  if (sessionCsrf) return sessionCsrf;
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "ff_csrf" || k === "__Host-ff_csrf") return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const t = csrfToken();
    if (t) headers["x-csrf-token"] = t;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, credentials: "same-origin", cache: "no-store", signal: init.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Could not reach the FlowForge API. Check that it is running.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, "invalid_response", `The API answered ${res.status} with something that is not JSON.`);
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `Request failed with ${res.status}`, e?.details);
  }
  return json as T;
}
