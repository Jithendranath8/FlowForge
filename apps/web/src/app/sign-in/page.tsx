import type { Metadata } from "next";
import { Logo } from "@/components/site/Logo";
import { safeReturnTo } from "@/lib/return-to";
import { SignInOptions } from "./SignInOptions";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled at the provider.",
  not_allowed: "This email address is not allowed to sign in here. Ask an administrator to add it to AUTH_ALLOWED_EMAILS, or to give you access with flowforge-admin add-member.",
  email_unverified: "Your account at the provider has no verified email address. Verify one there, then try again.",
  invalid_state: "That sign-in link expired or was already used. Start again.",
  provider_error: "The provider refused the sign-in. Try again; if it keeps happening, check the provider's client credentials.",
  unavailable: "The provider did not answer in time. Try again in a moment.",
  not_configured: "That provider is not configured on this server.",
  rate_limited: "Too many sign-in attempts from your network. Wait a minute, then try again.",
  unknown_provider: "That sign-in provider does not exist.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : undefined;
  const returnTo = safeReturnTo(params.returnTo);
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-8 text-xl font-semibold tracking-[-0.01em] text-ink">Sign in to FlowForge</h1>
        <p className="mt-2 text-sm text-muted">Use the account your administrator allowed. FlowForge never sees your password.</p>
        {error ? (
          <p role="alert" className="mt-6 rounded-[var(--radius-control)] border px-3 py-2.5 text-sm text-ink" style={{ borderColor: "color-mix(in srgb, var(--st-failed) 45%, transparent)", background: "color-mix(in srgb, var(--st-failed) 8%, transparent)" }}>
            {ERRORS[error] ?? "Sign-in failed. Try again."}
          </p>
        ) : null}
        <SignInOptions returnTo={returnTo} />
        <p className="mt-8 text-xs text-faint">
          Signing in sets a session cookie for this site only. SDKs and workers use API keys instead; see <a className="underline underline-offset-2 hover:text-muted" href="/docs/security">the security model</a>.
        </p>
      </div>
    </main>
  );
}
