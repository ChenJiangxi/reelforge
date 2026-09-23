import { NextRequest, NextResponse } from "next/server";
import { createWriteStream, statfsSync } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { isSafeId, projectMediaDir, safeFileName } from "@/lib/media";

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
  if (!projectId || !isSafeId(projectId) || !(file instanceof File)) {
    return NextResponse.json({ error: "projectId + file required" }, { status: 400 });
  }

  const name = safeFileName(file.name || "file");
  const dir = projectMediaDir(projectId);
  // 盘满之前就拒收,并且说清楚是服务器的盘 —— 不然写到一半 ENOSPC,worker 那边只看到一个 500
  try {
    const st = statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    const need = file.size + 300 * 1024 * 1024;
    if (free < need) {
      return NextResponse.json(
        { error: `服务器磁盘只剩 ${(free / 1073741824).toFixed(1)} GB,放不下 ${name}(${(file.size / 1048576).toFixed(0)} MB,另留 300 MB 余量)`, disk: true },
        { status: 507 },
      );
    }
  } catch {
    /* statfs 不可用就照旧写 */
  }
  const dest = path.join(dir, name);
  // Stream to disk (videos can be hundreds of MB; the server has 1.6G RAM).
  const nodeStream = Readable.fromWeb(file.stream() as never);
  await pipeline(nodeStream, createWriteStream(dest));

  return NextResponse.json({ ok: true, url: `/api/media/${projectId}/${name}` });
}
