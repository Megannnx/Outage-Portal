import { NextResponse, type NextRequest } from "next/server";
// Fast redirect for page requests without a session cookie. Real authorisation happens server-side per request.
const PUBLIC = ["/login", "/dispatch/", "/api/", "/_next/", "/favicon", "/icon"];
export function middleware(req: NextRequest) {
  const p = req.nextUrl.pathname;
  if (PUBLIC.some((x) => p.startsWith(x))) return NextResponse.next();
  if (!req.cookies.get("atec_op_session")) {
    const u = req.nextUrl.clone(); u.pathname = "/login"; u.search = p === "/" ? "" : `?next=${encodeURIComponent(p)}`;
    return NextResponse.redirect(u);
  }
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
