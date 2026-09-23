import archiver from "archiver";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import path from "path";
import { prisma } from "./db";
import type { Artifacts } from "./stages";
import { MEDIA_DIR } from "./media";

// Package the delivered project: final video + vertical cover + Douyin caption.
// Media files are located from artifact URLs (/api/media/<projectId>/<file>)
// back to MEDIA_DIR paths.
// 2026-09-13 起上传的 URL 都带 ?v=<时间戳>(防浏览器缓存旧文件)—— 这里以前没去掉查询串,
// 拿 "subs.mp4?v=…" 当文件名去盘上找,当然找不到,于是下载包里只有 video-MISSING.txt,
// 而且不报错。先去掉 ? 之后的部分再拼路径。
function urlToPath(projectId: string, url?: string): string | undefined {
  if (!url) return undefined;
  const prefix = `/api/media/${projectId}/`;
  if (!url.startsWith(prefix)) return undefined;
  const rel = url.slice(prefix.length).split("?")[0].split("#")[0];
  return path.join(MEDIA_DIR, projectId, decodeURIComponent(rel));
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
  // 包里缺东西必须说出来,不能只在 zip 里塞一个 MISSING.txt
  const missing = [
    !(video && existsSync(video)) ? "成片视频" : "",
    !(cover && existsSync(cover)) ? "封面" : "",
    !caption ? "文案" : "",
  ].filter(Boolean);
  if (missing.length) {
    await prisma.message.create({
      data: { projectId, role: "agent", text: `下载包打好了,但缺了:${missing.join("、")}。找不到对应文件,需要把那一步重做一次。` },
    });
  }
  return zipPath;
}
