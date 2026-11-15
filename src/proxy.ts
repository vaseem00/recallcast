import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 "proxy" (the renamed middleware.ts convention).
 * Redirects unauthenticated /app/* requests to /login by checking only that the
 * session cookie is present. The real session check happens in server
 * components and route handlers (requireUser()).
 */
export function proxy(request: NextRequest) {
  if (!request.cookies.get("rc_session")?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};
