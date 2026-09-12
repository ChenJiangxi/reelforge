import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
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

  const clips: ClipThumb[] = (script.clips ?? []).map(
    (c: { name: string; text: string }, i: number) => ({
      name: c.name,
      text: c.text,
      image: footage.images?.[i],
      dur: voice.voiceMeta?.clips?.[i]?.dur,
    }),
  );

  return (
    <div className="max-w-6xl">
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← 全部项目
      </a>
      <div className="mt-2 mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{project.title}</h1>
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

      <ProjectWorkspace
        projectId={project.id}
        stages={stages}
        messages={project.messages.map((m) => ({ role: m.role, text: m.text, ts: m.createdAt.getTime() }))}
        clips={clips}
        aspect={project.aspect}
        audio={voice.audio}
        wave={voice.wave}
      />
    </div>
  );
}
