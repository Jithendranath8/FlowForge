import { CodeChallengeMethod, OAuth2Client } from "arctic";
import { z } from "zod";

/*
 * OAuth 2.0 identity providers (ADR-018). Authorization-code flow with state and PKCE
 * (S256) for both providers, on arctic's generic OAuth2Client, so endpoints are explicit
 * (and tests can point them at a local stand-in; nothing in configuration can).
 *
 * Only a verified email is accepted: it is what the sign-in allowlist and account linking
 * rely on.
 */

export const PROVIDER_IDS = ["google", "github"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface OAuthIdentity {
  provider: ProviderId;
  /** The provider's stable account id (Google `sub`, GitHub numeric id). */
  subject: string;
  /** Lower-cased, verified email address. */
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface ProviderEndpoints {
  authorization: string;
  token: string;
  userinfo: string;
  /** GitHub only: the user's email addresses with their verification state. */
  emails?: string;
}

export const ENDPOINTS: Record<ProviderId, ProviderEndpoints> = {
  google: {
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  github: {
    authorization: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    userinfo: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  },
};

const SCOPES: Record<ProviderId, string[]> = {
  google: ["openid", "email", "profile"],
  github: ["read:user", "user:email"],
};

/** Why sign-in failed, as shown on the sign-in page (never provider internals). */
export class SignInError extends Error {
  constructor(
    readonly code: "provider_error" | "email_unverified" | "not_allowed" | "invalid_state" | "unavailable",
    message: string,
    /** Safe to log: never an email address (see emailForLog). */
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export interface OAuthProvider {
  readonly id: ProviderId;
  authorizationUrl(state: string, codeVerifier: string): URL;
  /** Exchange the code (with its PKCE verifier) and return the verified identity. */
  identify(code: string, codeVerifier: string): Promise<OAuthIdentity>;
}

export interface ProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Per outbound request to the provider. */
  timeoutMs?: number;
  /** Tests only: a local stand-in provider. */
  endpoints?: ProviderEndpoints;
}

const GoogleUser = z.object({
  sub: z.string().min(1),
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.url().optional(),
});
const GitHubUser = z.object({ id: z.number().int(), login: z.string(), name: z.string().nullable().optional(), avatar_url: z.url().nullable().optional() });
const GitHubEmails = z.array(z.object({ email: z.email(), primary: z.boolean(), verified: z.boolean() }));

export function createProvider(id: ProviderId, opts: ProviderOptions): OAuthProvider {
  const endpoints = opts.endpoints ?? ENDPOINTS[id];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const client = new OAuth2Client(opts.clientId, opts.clientSecret, opts.redirectUri);

  /** A provider that hangs must not hang sign-in (arctic's own request has no timeout). */
  const bounded = async <T>(p: Promise<T>, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SignInError("unavailable", `${id} ${what} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const getJson = async (url: string, accessToken: string): Promise<unknown> => {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: id === "github" ? "application/vnd.github+json" : "application/json",
        "user-agent": "flowforge",
        ...(id === "github" ? { "x-github-api-version": "2022-11-28" } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      throw new SignInError("unavailable", `${id} request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new SignInError("provider_error", `${id} answered ${res.status} for ${new URL(url).pathname}`);
    return res.json();
  };

  return {
    id,
    authorizationUrl(state, codeVerifier) {
      const url = client.createAuthorizationURLWithPKCE(endpoints.authorization, state, CodeChallengeMethod.S256, codeVerifier, SCOPES[id]);
      if (id === "google") url.searchParams.set("prompt", "select_account");
      return url;
    },
    async identify(code, codeVerifier) {
      let accessToken: string;
      try {
        const tokens = await bounded(client.validateAuthorizationCode(endpoints.token, code, codeVerifier), "token exchange");
        accessToken = tokens.accessToken();
      } catch (err) {
        if (err instanceof SignInError) throw err;
        throw new SignInError("provider_error", `${id} token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (id === "google") {
        const u = GoogleUser.safeParse(await getJson(endpoints.userinfo, accessToken));
        if (!u.success) throw new SignInError("provider_error", "google userinfo had an unexpected shape");
        if (!u.data.email || u.data.email_verified !== true) throw new SignInError("email_unverified", "Your Google account has no verified email address");
        return { provider: id, subject: u.data.sub, email: u.data.email.toLowerCase(), name: u.data.name ?? null, avatarUrl: u.data.picture ?? null };
      }

      const user = GitHubUser.safeParse(await getJson(endpoints.userinfo, accessToken));
      const emails = GitHubEmails.safeParse(await getJson(endpoints.emails!, accessToken));
      if (!user.success || !emails.success) throw new SignInError("provider_error", "github user had an unexpected shape");
      const primary = emails.data.find((e) => e.primary && e.verified);
      if (!primary) throw new SignInError("email_unverified", "Your GitHub account has no verified primary email address");
      return {
        provider: id,
        subject: String(user.data.id),
        email: primary.email.toLowerCase(),
        name: user.data.name ?? user.data.login,
        avatarUrl: user.data.avatar_url ?? null,
      };
    },
  };
}
