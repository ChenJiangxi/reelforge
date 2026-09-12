import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { projectMediaDir, safeFileName } from "@/lib/media";

// POST /api/worker/upload — multipart form: projectId + file.
// Saves to MEDIA_DIR/<projectId>/<name> and returns the /api/media URL the
// worker should put into artifacts.
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart form required" }, { status: 400 });
  const projectId = String(form.get("projectId") ?? "");
  const file = form.get("file");
  if (!projectId || !(file instanceof File)) {
    return NextResponse.json({ error: "projectId + file required" }, { status: 400 });
  }

  const name = safeFileName(file.name || "file");
  const dir = projectMediaDir(projectId);
  const dest = path.join(dir, name);
  // Stream to disk (videos can be hundreds of MB; the server has 1.6G RAM).
  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(dest));

  return NextResponse.json({ ok: true, url: `/api/media/${projectId}/${name}` });
}
