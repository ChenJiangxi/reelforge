import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";
import type { Artifacts } from "@/lib/stages";

export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const kind = req.nextUrl.searchParams.get("kind");
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { stages: true } });
  if (!project) return new Response("not found", { status: 404 });

  const edit = project.stages.find((s) => s.kind === "edit");
  const deliver = project.stages.find((s) => s.kind === "deliver");
  const editArt: Artifacts = edit?.artifacts ? JSON.parse(edit.artifacts) : {};
  const delArt: Artifacts = deliver?.artifacts ? JSON.parse(deliver.artifacts) : {};

  const filePath = kind === "cover" ? delArt.cover || editArt.cover : editArt.video;
  if (!filePath || !existsSync(filePath)) return new Response("no file", { status: 404 });

  const stat = statSync(filePath);
  const contentType = kind === "cover" ? "image/png" : "video/mp4";
  const range = req.headers.get("range");

  if (range && contentType === "video/mp4") {
    const [rs, re] = range.replace("bytes=", "").split("-");
    const start = parseInt(rs, 10);
    const end = re ? parseInt(re, 10) : stat.size - 1;
    const nodeStream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        "Content-Type": contentType,
      },
    });
  }

  const nodeStream = createReadStream(filePath);
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    headers: {
      "Content-Length": String(stat.size),
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    },
  });
}
