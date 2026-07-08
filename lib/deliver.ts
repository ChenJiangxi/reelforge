import archiver from "archiver";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import path from "path";
import { prisma } from "./db";
import type { Artifacts } from "./stages";

// TODO(real): plug the actual generators here —
//   - vertical cover via the codex 命盘 flow (make-cover-hv.py style)
//   - Douyin caption via an LLM pass over the script
// v0 packages whatever assets the stages already carry.
export async function runDelivery(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { stages: true },
  });
  if (!project) throw new Error("project not found");

  const edit = project.stages.find((s) => s.kind === "edit");
  const deliver = project.stages.find((s) => s.kind === "deliver");
  const editArt: Artifacts = edit?.artifacts ? JSON.parse(edit.artifacts) : {};
  const delArt: Artifacts = deliver?.artifacts ? JSON.parse(deliver.artifacts) : {};

  const video = editArt.video;
  const cover = delArt.cover || editArt.cover;
  const caption = delArt.caption || editArt.caption;

  const outDir = path.join(process.cwd(), "data", "packages");
  mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${projectId}.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);

    if (video && existsSync(video)) archive.file(video, { name: "video.mp4" });
    else archive.append("video TODO — draft not found", { name: "video-TODO.txt" });

    if (cover && existsSync(cover)) archive.file(cover, { name: "cover-vertical.png" });
    else archive.append("cover TODO — codex vertical cover not generated yet", { name: "cover-TODO.txt" });

    const cap = caption
      ? `${caption.title}\n\n${(caption.hashtags || []).join(" ")}\n\n${caption.desc}`
      : "caption TODO — Douyin 文案 not generated yet";
    archive.append(cap, { name: "caption.txt" });

    archive.finalize();
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "delivered", packagePath: zipPath },
  });
  return zipPath;
}
