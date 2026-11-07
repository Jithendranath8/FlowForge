import { NextResponse, type NextRequest } from "next/server";

/**
 * Signed-out visitors to /dashboard go straight to sign-in (no flash of an empty shell).
 * This only checks that a session cookie exists; the API decides whether it is valid,
 * and the dashboard sends the visitor to sign-in when the API says it is not.
 */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("ff_session") || req.cookies.has("__Host-ff_session");
  if (hasSession) return NextResponse.next();
  const url = new URL("/sign-in", req.url);
  url.searchParams.set("returnTo", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/dashboard", "/dashboard/:path*"] };
