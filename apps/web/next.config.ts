import type { NextConfig } from "next";

/**
 * The web app is the only origin browsers talk to (ADR-008): /api/* is forwarded to the
 * FlowForge API, so session cookies are first-party and no CORS is involved. Next forwards
 * the client's own X-Forwarded-For untouched and adds nothing, so production runs through
 * server.mjs, which sets it from the real connection; the API then sets TRUST_PROXY to
 * this server's address (docs/OPERATIONS and /docs/operations#client-addresses-behind-proxies).
 * API_INTERNAL_URL is read by `next build`, which writes the rewrite into its output.
 */
const api = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

/**
 * Content-Security-Policy. Next.js bootstraps the page with inline scripts and the theme
 * is set by a small inline script before paint, so scripts may be inline ('unsafe-inline';
 * removing it needs per-request nonces, which would make every page dynamic). Everything
 * else is locked to this origin: no external scripts, fetches, frames, plugins or form
 * targets. Development additionally needs eval for React Refresh.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Live updates are Server-Sent Events through /api/v1/stream; compression would buffer them.
  compress: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default config;
