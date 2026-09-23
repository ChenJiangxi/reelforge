import { NextRequest, NextResponse } from "next/server";
import { isSafeId } from "@/lib/media";
import { enqueueCapture, taskOf } from "@/lib/worker-tasks";

// POST { url, name } → 让渲染机录这个产品页(手机尺寸整页长图 + 每段文字的位置),录完进素材库
// GET ?task=id → { status, error? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  let url: URL;
  try {
    url = new URL(String(body.url ?? ""));
  } catch {
    return NextResponse.json({ error: "网址不对" }, { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) return NextResponse.json({ error: "只能录 http/https 网页" }, { status: 400 });
  const name = String(body.name ?? "").trim().slice(0, 40) || url.pathname.split("/").filter(Boolean).pop() || url.host;
  const t = enqueueCapture(id, url.toString(), name);
  return NextResponse.json({ task: t.id, name });
}

export async function GET(req: NextRequest) {
  const t = taskOf(req.nextUrl.searchParams.get("task") ?? "");
  if (!t) return NextResponse.json({ status: "unknown" });
  return NextResponse.json({ status: t.status, error: t.error, name: t.name });
}
