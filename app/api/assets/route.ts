import { NextRequest, NextResponse } from "next/server";
import { createWriteStream, readdirSync, statSync, mkdirSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { MEDIA_DIR } from "@/lib/media";

// 全局共享素材库:MEDIA_DIR/_global/assets/,所有项目的素材阶段都能用。
const GLOBAL_DIR = () => {
  const d = path.join(MEDIA_DIR, "_global", "assets");
  mkdirSync(d, { recursive: true });
  return d;
};
const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

export function listGlobalAssets() {
  let files: string[] = [];
  try { files = readdirSync(GLOBAL_DIR()); } catch { return []; }
  return files
    .filter((f) => VIDEO.test(f) || IMAGE.test(f))
    .map((f) => ({
      name: f,
      url: `/api/media/_global/assets/${encodeURIComponent(f)}`,
      kind: VIDEO.test(f) ? "video" : "image",
      size: statSync(path.join(GLOBAL_DIR(), f)).size,
    }));
}

export async function GET() {
  return NextResponse.json(listGlobalAssets());
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart required" }, { status: 400 });
  const saved = [];
  for (const file of form.getAll("files")) {
    if (!(file instanceof File)) continue;
    const name = path.basename(file.name).replace(/\.\./g, "").replace(/[\\/:*?"<>|]/g, "_").trim() || `asset-${Date.now()}`;
    const nodeStream = Readable.fromWeb(file.stream() as never);
    await pipeline(nodeStream, createWriteStream(path.join(GLOBAL_DIR(), name)));
    saved.push(name);
  }
  if (!saved.length) return NextResponse.json({ error: "no files" }, { status: 400 });
  return NextResponse.json({ ok: true, saved });
}
