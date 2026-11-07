import { redactDbError } from "@flowforge/db";
import pino from "pino";

/**
 * Log serializers for the API's logger. `err` goes through redactDbError first, so a
 * failed query's parameters and a Postgres error's row `detail` (tenant data) never
 * reach the logs.
 */
/** Query parameters whose values are credentials (OAuth callback code and state, tokens, keys). */
const SENSITIVE_QUERY = new Set(["code", "state", "token", "access_token", "id_token", "refresh_token", "key", "api_key", "apikey", "secret", "password", "session", "sig", "signature"]);

/**
 * A URL for logging: the path and query as received, with the values of credential-like
 * query parameters replaced by "[redacted]" (`/auth/google/callback?code=…&state=…`).
 */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const query = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        // keep the raw name
      }
      return SENSITIVE_QUERY.has(name.toLowerCase()) ? `${pair.slice(0, eq)}=[redacted]` : pair;
    })
    .join("&");
  return `${url.slice(0, q)}?${query}`;
}

interface LoggedRequest {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

export const logSerializers = {
  err: (err: unknown) => pino.stdSerializers.err(redactDbError(err) as Error),
  /** Fastify's request fields, with the URL's credentials redacted. */
  req: (req: LoggedRequest) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }),
};
