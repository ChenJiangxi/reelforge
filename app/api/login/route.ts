import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

// 整个站就靠这一个共享口令挡着,以前可以无限次试。同一个 IP 15 分钟内错 8 次就先锁 15 分钟。
// 记在进程内存里就够了(单进程,重启清零无所谓)。
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const fails = new Map<string, { n: number; first: number }>();

function clientIp(req: NextRequest): string {
  return (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "local").trim();
}

// POST /api/login { code } — verify the shared access code, set the auth cookie.
export async function POST(req: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) return NextResponse.json({ ok: true });

  const ip = clientIp(req);
  const now = Date.now();
  const rec = fails.get(ip);
  if (rec && now - rec.first > WINDOW_MS) fails.delete(ip);
  const cur = fails.get(ip);
  if (cur && cur.n >= MAX_FAILS) {
    const mins = Math.ceil((WINDOW_MS - (now - cur.first)) / 60000);
    return NextResponse.json({ error: `试错太多次了,${mins} 分钟后再试` }, { status: 429 });
  }

  const { code: got } = await req.json().catch(() => ({}));
  if (got !== code) {
    fails.set(ip, { n: (cur?.n ?? 0) + 1, first: cur?.first ?? now });
    if (fails.size > 5000) fails.clear(); // 防止被刷爆内存
    return NextResponse.json({ error: "口令不对" }, { status: 401 });
  }
  fails.delete(ip);
  const token = createHash("sha256").update(`reelforge:${code}`).digest("hex");
  const res = NextResponse.json({ ok: true });
  res.cookies.set("rf_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
