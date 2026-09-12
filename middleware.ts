import { NextRequest, NextResponse } from "next/server";

// Minimal shared-password gate (ACCESS_CODE env). Not a user system — it just
// keeps the public site from being wide open. /api/worker/* is exempt: the
// worker authenticates with its own bearer token (lib/worker-auth.ts).
// If ACCESS_CODE is unset (local dev), the gate is open.

async function expected(): Promise<string | null> {
  const code = process.env.ACCESS_CODE;
  if (!code) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`reelforge:${code}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function middleware(req: NextRequest) {
  const want = await expected();
  if (!want) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/api/worker/") ||
    pathname.startsWith("/api/media/") || // media URLs carry an unguessable projectId; worker fetches them too
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/login") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  if (req.cookies.get("rf_auth")?.value === want) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
