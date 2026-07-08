import { prisma } from "@/lib/db";
import { runDelivery } from "@/lib/deliver";
import { createReadStream, existsSync, statSync } from "fs";
import { Readable } from "stream";

export async function GET(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return new Response("not found", { status: 404 });

  let zip = project.packagePath;
  if (!zip || !existsSync(zip)) zip = await runDelivery(projectId);

  const stat = statSync(zip);
  return new Response(Readable.toWeb(createReadStream(zip)) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="reelforge-${projectId}.zip"`,
    },
  });
}
