import { NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import { contentTypeFor, mediaPath } from "@/lib/media";

// Streams a generated media file from MEDIA_DIR/<projectId>/<file>.
// Range-supported so <video> seeking works. Files are written by the worker
// via /api/worker/upload; serving them here (not from public/) means files
// added after process boot work immediately.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; file: string[] }> },
) {
  const { projectId, file } = await params;
  // 每一段都校验,不能靠 basename:projectId 本身也是用户给的(实见 ..%2Fdata 能读到数据库)
  const filePath = mediaPath(projectId, file);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response("not found", { status: 404 });
  }

  const stat = statSync(filePath);
  const type = contentTypeFor(filePath);
  const range = req.headers.get("range");

  if (range) {
    const [rs, re] = range.replace("bytes=", "").split("-");
    const start = parseInt(rs, 10);
    const end = re ? parseInt(re, 10) : stat.size - 1;
    if (!Number.isNaN(start) && start < stat.size) {
      const nodeStream = createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Content-Type": type,
        },
      });
    }
  }

  const nodeStream = createReadStream(filePath);
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      // 媒体原地覆盖(card-c01.png 换了内容不换名):必须每次向服务器再校验,304 走缓存
      "Cache-Control": "no-cache",
      "Last-Modified": stat.mtime.toUTCString(),
    },
  });
}
