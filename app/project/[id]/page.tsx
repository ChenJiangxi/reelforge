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

  // 素材库(录屏/图片),扫盘得来
  const assetsDir = path.join(MEDIA_DIR, project.id, "assets");
  let assetFiles: string[] = [];
  try { assetFiles = readdirSync(assetsDir); } catch { /* none */ }
  const assets: Asset[] = assetFiles
    .filter((f) => /\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif)$/i.test(f))
    .map((f) => ({
      name: f,
      url: `/api/media/${project.id}/assets/${encodeURIComponent(f)}`,
      kind: /\.(mp4|mov|webm|m4v)$/i.test(f) ? "video" : "image",
      size: statSync(path.join(assetsDir, f)).size,
    }));

  return (
    <div className="project-shell max-w-[1600px]">
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← 全部项目
      </a>
      <div className="mt-2 mb-1.5 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
        <StatusBadge status={project.status} />
      </div>
      <p className="mb-2 text-sm text-muted-foreground">{project.topic}</p>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {settings.map((s) => (
          <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {s}
          </span>
        ))}
      </div>

      <AssetBar projectId={project.id} assets={assets} />

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
