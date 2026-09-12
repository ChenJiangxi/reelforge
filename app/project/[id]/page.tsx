import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { StageCard } from "@/components/StageCard";
import { StatusBadge } from "@/components/StatusBadge";
import { stageLabel } from "@/lib/stages";

export const dynamic = "force-dynamic";

const DOT: Record<string, string> = {
  approved: "bg-success",
  awaiting_review: "bg-accent ring-4 ring-accent-soft",
  working: "bg-accent animate-pulse",
  changes_requested: "bg-destructive",
  pending: "bg-border",
};

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) notFound();

  const settings = [
    project.platform === "bilibili" ? "B站横版" : "抖音竖版",
    project.aspect,
    project.voice === "clone-zh" ? "克隆音·中文" : "英文旁白",
    project.bgm === "yes" ? "带 BGM" : "无 BGM",
    `~${project.duration}s`,
  ];

  return (
    <div className="max-w-3xl">
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← 项目
      </a>
      <div className="mt-2 mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{project.title}</h1>
        <StatusBadge status={project.status} />
      </div>
      <p className="mb-2 text-sm text-muted-foreground">{project.topic}</p>
      <div className="mb-6 flex flex-wrap gap-1.5">
        {settings.map((s) => (
          <span key={s} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {s}
          </span>
        ))}
      </div>

      {/* pipeline stepper */}
      <div className="mb-6 flex items-center rounded-lg border border-border bg-card px-4 py-3">
        {project.stages.map((s, i) => (
          <div key={s.id} className="flex min-w-0 flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span className={`size-2 rounded-full ${DOT[s.status] ?? DOT.pending}`} />
              <span
                className={`whitespace-nowrap text-[10px] ${
                  s.status === "awaiting_review" ? "font-medium text-accent" : "text-muted-foreground"
                }`}
              >
                {stageLabel(s.kind)}
              </span>
            </div>
            {i < project.stages.length - 1 && (
              <div className={`mx-1 mb-4 h-px min-w-2 flex-1 ${s.status === "approved" ? "bg-success/50" : "bg-border"}`} />
            )}
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {project.stages.map((s) => (
          <StageCard
            key={s.id}
            projectId={project.id}
            stage={{
              id: s.id,
              kind: s.kind,
              order: s.order,
              status: s.status,
              artifacts: s.artifacts,
              comments: s.comments,
            }}
          />
        ))}
      </div>
    </div>
  );
}
