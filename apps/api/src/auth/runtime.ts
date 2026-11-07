import type { Config } from "../config.js";
import type { AuthRuntime } from "../http/routes/auth.js";
import { parseAllowlist } from "./accounts.js";
import { PROVIDER_IDS, createProvider, type OAuthProvider, type ProviderId } from "./providers.js";

/**
 * Sign-in configuration from the environment (ADR-018). A provider is enabled when both
 * its client id and secret are set. Callbacks live on the web app's origin, which
 * forwards /api/* to the API: `${APP_URL}/api/auth/<provider>/callback`.
 */
export function authRuntimeFromConfig(c: Config): AuthRuntime {
  const appUrl = c.APP_URL.replace(/\/+$/, "");
  const credentials: Record<ProviderId, [string | undefined, string | undefined]> = {
    google: [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET],
    github: [c.GITHUB_CLIENT_ID, c.GITHUB_CLIENT_SECRET],
  };
  const providers = new Map<ProviderId, OAuthProvider>();
  for (const id of PROVIDER_IDS) {
    const [clientId, clientSecret] = credentials[id];
    if (clientId && clientSecret) providers.set(id, createProvider(id, { clientId, clientSecret, redirectUri: `${appUrl}/api/auth/${id}/callback` }));
  }
  return {
    appUrl,
    providers,
    allowlist: parseAllowlist(c.AUTH_ALLOWED_EMAILS, c.AUTH_ALLOW_ANY_EMAIL),
    policy: {
      secret: c.SESSION_SECRET,
      ttlMs: c.SESSION_TTL_HOURS * 3_600_000,
      absoluteTtlMs: c.SESSION_ABSOLUTE_TTL_HOURS * 3_600_000,
      secureCookies: appUrl.startsWith("https://"),
    },
  };
}
