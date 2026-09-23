import { NextRequest, NextResponse } from "next/server";
import { createWriteStream, readdirSync, statSync, mkdirSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { MEDIA_DIR, isSafeId, projectMediaDir } from "@/lib/media";

// Project asset library: 录屏/图片 she uploads. Files live in
// MEDIA_DIR/<id>/assets/ and the list is derived by scanning the dir —
// no schema change. Unicode names kept (they're labels the LLM matches on).
const VIDEO = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function assetName(raw: string): string {
  const base = path.basename(raw).replace(/\.\./g, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return base || `asset-${Date.now()}`;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const dir = path.join(MEDIA_DIR, id, "assets");
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { /* no assets yet */ }
  const assets = files
    .filter((f) => VIDEO.has(path.extname(f).toLowerCase()) || IMAGE.has(path.extname(f).toLowerCase()))
    .map((f) => ({
      name: f,
      url: `/api/media/${id}/assets/${encodeURIComponent(f)}`,
      kind: VIDEO.has(path.extname(f).toLowerCase()) ? "video" : "image",
      size: statSync(path.join(dir, f)).size,
    }));
  return NextResponse.json(assets);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSafeId(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart required" }, { status: 400 });
  const dir = path.join(projectMediaDir(id), "assets");
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const file of form.getAll("files")) {
    if (!(file instanceof File)) continue;
    const name = assetName(file.name);
    const nodeStream = Readable.fromWeb(file.stream() as never);
    await pipeline(nodeStream, createWriteStream(path.join(dir, name)));
    saved.push(name);
  }
  if (!saved.length) return NextResponse.json({ error: "no files" }, { status: 400 });
  return NextResponse.json({ ok: true, saved });
}
