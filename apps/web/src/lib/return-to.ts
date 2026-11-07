/**
 * Where to send the visitor after sign-in: a path on this site, or the dashboard.
 * Same rules as the API's safeReturnTo (apps/api/src/auth/sessions.ts). Control
 * characters matter: browsers drop tabs and newlines while parsing a URL, so
 * "/\t/evil.example" would become the off-site "//evil.example".
 */
export function safeReturnTo(value: string | string[] | undefined, fallback = "/dashboard"): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || v.length > 512) return fallback;
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return fallback;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return fallback;
  }
  return v;
}
