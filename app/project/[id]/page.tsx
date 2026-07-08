import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { StageCard } from "@/components/StageCard";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) notFound();

  return (
    <div className="max-w-3xl">
      <a href="/" className="text-sm text-foreground/50 hover:text-foreground">
        ← 项目
      </a>
      <div className="mt-2 mb-1 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{project.title}</h1>
        <StatusBadge status={project.status} />
      </div>
      <p className="mb-6 text-sm text-foreground/50">
        #{project.platform} · {project.topic}
      </p>
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
