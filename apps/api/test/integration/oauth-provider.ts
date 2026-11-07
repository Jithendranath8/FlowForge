import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { ProviderEndpoints } from "../../src/auth/providers.js";

/*
 * TEST INFRASTRUCTURE ONLY: a local OAuth 2.0 authorization server that behaves like
 * Google's and GitHub's for the parts FlowForge uses. It enforces what a real provider
 * enforces (client authentication, PKCE S256, single-use codes, redirect URI match), so
 * the tests exercise FlowForge's real flow. It is never part of the product (ADR-018);
 * sign-in against the real providers is verified separately and reported as such.
 */

export interface StubIdentity {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  /** GitHub: extra (non-primary or unverified) addresses. */
  otherEmails?: { email: string; primary: boolean; verified: boolean }[];
}

interface Grant {
  challenge: string;
  redirectUri: string;
  identity: StubIdentity;
}

export class StubOAuthServer {
  readonly clientId = "stub-client";
  readonly clientSecret = "stub-secret";
  private server = http.createServer((req, res) => void this.handle(req, res));
  private codes = new Map<string, Grant>();
  private tokens = new Map<string, StubIdentity>();
  /** Requests seen at the token endpoint, for assertions. */
  readonly tokenRequests: { verifierMatched: boolean; basicAuth: boolean }[] = [];
  /** When set, the token endpoint never answers. */
  hangTokenEndpoint = false;
  base = "";

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  endpoints(kind: "google" | "github"): ProviderEndpoints {
    return kind === "google"
      ? { authorization: `${this.base}/authorize`, token: `${this.base}/token`, userinfo: `${this.base}/google/userinfo` }
      : { authorization: `${this.base}/authorize`, token: `${this.base}/token`, userinfo: `${this.base}/github/user`, emails: `${this.base}/github/emails` };
  }

  /**
   * What the provider does when the user approves: issue a code bound to the request's
   * PKCE challenge and redirect URI. Returns the code.
   */
  approve(authorizationUrl: string, identity: StubIdentity): string {
    const u = new URL(authorizationUrl);
    const challenge = u.searchParams.get("code_challenge");
    if (u.searchParams.get("code_challenge_method") !== "S256" || !challenge) throw new Error("authorization request without S256 PKCE");
    if (u.searchParams.get("client_id") !== this.clientId) throw new Error("wrong client_id");
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, { challenge, redirectUri: u.searchParams.get("redirect_uri") ?? "", identity });
    return code;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

    if (req.method === "POST" && url.pathname === "/token") {
      if (this.hangTokenEndpoint) return; // never answers
      const form = new URLSearchParams(body);
      const basic = req.headers.authorization === `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
      const grant = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const verifierMatched = Boolean(grant) && createHash("sha256").update(verifier).digest("base64url") === grant!.challenge;
      this.tokenRequests.push({ verifierMatched, basicAuth: basic });
      if (!basic) return json(401, { error: "invalid_client" });
      if (!grant || !verifierMatched || form.get("redirect_uri") !== grant.redirectUri) return json(400, { error: "invalid_grant" });
      this.codes.delete(form.get("code")!); // single use
      const accessToken = randomBytes(16).toString("hex");
      this.tokens.set(accessToken, grant.identity);
      return json(200, { access_token: accessToken, token_type: "bearer", expires_in: 3600 });
    }

    const identity = this.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!identity) return json(401, { error: "invalid_token" });
    if (url.pathname === "/google/userinfo") {
      return json(200, { sub: identity.sub, email: identity.email, email_verified: identity.emailVerified ?? true, name: identity.name, picture: "https://example.com/a.png" });
    }
    if (url.pathname === "/github/user") return json(200, { id: Number(identity.sub), login: `user${identity.sub}`, name: identity.name ?? null, avatar_url: null });
    if (url.pathname === "/github/emails") {
      return json(200, [{ email: identity.email, primary: true, verified: identity.emailVerified ?? true }, ...(identity.otherEmails ?? [])]);
    }
    json(404, { error: "not_found" });
  }
}
