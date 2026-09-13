import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { readdirSync, statSync } from "fs";
import path from "path";
import { StatusBadge } from "@/components/StatusBadge";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { AssetBar, type Asset } from "@/components/AssetBar";
import { MEDIA_DIR } from "@/lib/media";
import type { ClipThumb, StageView } from "@/components/PreviewPane";
import type { Artifacts, Comment } from "@/lib/stages";
import { ASPECT_OPTIONS, voiceLabel } from "@/lib/stages";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      stages: { orderBy: { order: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  const settings = [
    ASPECT_OPTIONS.find((o) => o.value === project.aspect)?.label ?? project.aspect,
    voiceLabel(project.voice),
    project.bgm === "yes" ? "带 BGM" : "无 BGM",
    `~${project.duration}s`,
  ];

  const stages: StageView[] = project.stages.map((s) => ({
    id: s.id,
    kind: s.kind,
    order: s.order,
    status: s.status,
    artifacts: (s.artifacts ? JSON.parse(s.artifacts) : {}) as Artifacts,
    comments: (s.comments ? JSON.parse(s.comments) : []) as Comment[],
  }));

  const artOf = (kind: string) => stages.find((s) => s.kind === kind)?.artifacts ?? {};
  const script = artOf("script");
  const footage = artOf("footage");
  const voice = artOf("voice");
  const subs = artOf("subtitles").subs ?? [];

  const clips: ClipThumb[] = (script.clips ?? []).map(
    (c: { name: string; text: string }, i: number) => ({
      name: c.name,
      text: c.text,
      image: footage.images?.[i],
      dur: voice.voiceMeta?.clips?.[i]?.dur,
    }),
  );

  // 素材库(录屏/图片),扫盘得来:项目素材 + 全局共享素材,都可拖到节拍上
  const readAssets = (id: string): Asset[] => {
    const dir = path.join(MEDIA_DIR, id, "assets");
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { return []; }
    return files
      .filter((f) => /\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif)$/i.test(f))
      .map((f) => ({
        name: f,
        url: `/api/media/${id}/assets/${encodeURIComponent(f)}`,
        kind: /\.(mp4|mov|webm|m4v)$/i.test(f) ? "video" : "image",
        size: statSync(path.join(dir, f)).size,
      }));
  };
  const assets: Asset[] = [...readAssets(project.id), ...readAssets("_global")];

  return (
    <div className="project-shell max-w-[1600px]">
      {/* 头部一行:返回 + 标题 + 状态 + 设置 + 素材入口,全在一行,不占工作区 */}
      <div className="mb-1.5 flex shrink-0 items-center gap-3">
        <a href="/" className="shrink-0 text-sm text-muted-foreground hover:text-foreground">←</a>
        <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{project.title}</h1>
        <StatusBadge status={project.status} />
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground md:inline">
          {settings.join(" · ")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <AssetBar projectId={project.id} assets={assets} compact />
        </span>
      </div>
      <p className="mb-2 shrink-0 truncate text-xs text-muted-foreground" title={project.topic}>{project.topic}</p>

      <ProjectWorkspace
        projectId={project.id}
        stages={stages}
        messages={project.messages.map((m) => ({ role: m.role, text: m.text, ts: m.createdAt.getTime() }))}
        clips={clips}
        aspect={project.aspect}
        audio={voice.audio}
        wave={voice.wave}
        subs={subs}
      />
    </div>
  );
}
