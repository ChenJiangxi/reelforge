import { NextRequest, NextResponse } from "next/server";
import { listAssets, saveUploads } from "@/lib/media";

// 全局共享素材库:MEDIA_DIR/_global/assets/,所有项目的素材阶段都能用。

export async function GET() {
  return NextResponse.json(listAssets("_global"));
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart required" }, { status: 400 });
  const r = await saveUploads(form, "_global");
  if (r.error) return NextResponse.json(r, { status: 400 });
  return NextResponse.json({ ok: true, ...r });
}
