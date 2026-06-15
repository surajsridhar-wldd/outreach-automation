import { NextResponse } from "next/server";
export function middleware(req) {
  const hasSession = req.cookies.get("outreach_session");
  const { pathname } = req.nextUrl;
  const isPublic = pathname === "/login" || pathname.startsWith("/api/auth") || pathname.startsWith("/api/cron");
  if (!hasSession && !isPublic) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
