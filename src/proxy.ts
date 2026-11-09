import { NextResponse, type NextRequest } from "next/server";

/**
 * Cheap optimistic gate: no session cookie → send to /login before rendering.
 * Not a security boundary — every page, action and API route validates the
 * session and permissions on the server.
 */
export function proxy(req: NextRequest) {
  if (!req.cookies.has("loupe_session")) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/o/:path*", "/onboarding"] };
