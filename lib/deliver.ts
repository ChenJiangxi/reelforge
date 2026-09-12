import archiver from "archiver";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import path from "path";
import { prisma } from "./db";
import type { Artifacts } from "./stages";
import { MEDIA_DIR } from "./media";

// Package the delivered project: final video + vertical cover + Douyin caption.
// Media files are located from artifact URLs (/api/media/<projectId>/<file>)
// back to MEDIA_DIR paths.
function urlToPath(projectId: string, url?: string): string | undefined {
  if (!url) return undefined;
  const prefix = `/api/media/${projectId}/`;
  if (!url.startsWith(prefix)) return undefined;
  return path.join(MEDIA_DIR, projectId, decodeURIComponent(url.slice(prefix.length)));
}

export async function runDelivery(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { stages: true },
  });
  if (!project) throw new Error("project not found");

  const artOf = (kind: string): Artifacts => {
    const s = project.stages.find((x) => x.kind === kind);
    return s?.artifacts ? JSON.parse(s.artifacts) : {};
  };
  const edit = artOf("edit");
  const subs = artOf("subtitles");
  const polish = artOf("polish");
  const deliver = artOf("deliver");

  // The final cut is the last stage that produced a video.
  const video = urlToPath(projectId, polish.video || subs.video || edit.video);
  const cover = urlToPath(projectId, deliver.cover || edit.cover);
  const caption = deliver.caption || edit.caption;

  const outDir = path.join(MEDIA_DIR, projectId);
  mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `reelforge-${projectId}.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);

    if (video && existsSync(video)) archive.file(video, { name: "video.mp4" });
    else archive.append("video missing — no rendered cut found", { name: "video-MISSING.txt" });

    if (cover && existsSync(cover)) archive.file(cover, { name: "cover-vertical.png" });
    else archive.append("cover missing", { name: "cover-MISSING.txt" });

    const cap = caption
      ? `${caption.title}\n\n${(caption.hashtags || []).join(" ")}\n\n${caption.desc}`
      : "caption missing";
    archive.append(cap, { name: "caption.txt" });

    archive.finalize();
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { status: "delivered", packagePath: zipPath },
  });
  return zipPath;
}
