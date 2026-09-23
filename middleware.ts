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
  // 媒体和教案:浏览器带 cookie,worker 带自己的 Bearer token —— 两样都没有就拒。
  // 以前这两条对所有人开放(理由是"projectId 猜不到"),但 _global 素材库的 id 是固定的,
  // 再加上路径没校验,整个 /opt/reelforge 都能被读(见 lib/media.ts mediaPath)。
  const workerToken = process.env.WORKER_TOKEN;
  const isWorker = !!workerToken && req.headers.get("authorization") === `Bearer ${workerToken}`;
  if ((pathname.startsWith("/api/media/") || (req.method === "GET" && pathname.startsWith("/api/playbooks/"))) && isWorker) {
    return NextResponse.next();
  }
  if (
    pathname.startsWith("/api/worker/") ||
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
  // /api/worker/* 不进 proxy:proxy 会把请求体克隆成流(默认 10MB 截断),
  // worker 上传的成片/动画卡动辄 15-40MB,会被截成坏 multipart
  matcher: ["/((?!_next/static|_next/image|api/worker).*)"],
};
