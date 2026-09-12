import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

// POST /api/login { code } — verify the shared access code, set the auth cookie.
export async function POST(req: NextRequest) {
  const code = process.env.ACCESS_CODE;
  if (!code) return NextResponse.json({ ok: true });

  const { code: got } = await req.json().catch(() => ({}));
  if (got !== code) {
    return NextResponse.json({ error: "口令不对" }, { status: 401 });
  }
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
