import { NextRequest, NextResponse } from "next/server";
import { isSafeId, listAssets, saveUploads } from "@/lib/media";

// Project asset library: 录屏/图片 she uploads. Files live in
// MEDIA_DIR/<id>/assets/ and the list is derived by scanning the dir —
// no schema change. Unicode names kept (they're labels the LLM matches on).


export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  return NextResponse.json(listAssets(id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart required" }, { status: 400 });
  const r = await saveUploads(form, id);
  if (r.error) return NextResponse.json(r, { status: 400 });
  return NextResponse.json({ ok: true, ...r });
}
