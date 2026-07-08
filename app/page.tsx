import Link from "next/link";
import { prisma } from "@/lib/db";
import { StatusBadge } from "@/components/StatusBadge";
import { NewProjectButton } from "@/components/NewProjectButton";
import { stageLabel } from "@/lib/stages";

export const dynamic = "force-dynamic";

export default async function Home() {
  const projects = await prisma.project.findMany({
    include: { stages: true },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">项目</h1>
      <p className="mb-4 text-sm text-foreground/50">
        agent 在后台推进，卡在审核门等你。点开审。
      </p>
      <div className="mb-6">
        <NewProjectButton />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => {
          const ordered = [...p.stages].sort((a, b) => a.order - b.order);
          const current =
            ordered.find((s) => s.status === "awaiting_review") ??
            ordered.find((s) => s.status !== "approved");
          return (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="rounded-xl border border-border bg-card p-4 transition hover:border-accent/50"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 text-xs">#{p.platform}</span>
                <StatusBadge status={p.status} />
              </div>
              <div className="mb-3 font-semibold leading-snug">{p.title}</div>
              <div className="text-xs text-foreground/50">
                当前：{current ? stageLabel(current.kind) : "已完成"}
                {current?.status === "awaiting_review" && (
                  <span className="text-accent"> · 待你审</span>
                )}
              </div>
            </Link>
          );
        })}
        {projects.length === 0 && (
          <div className="text-foreground/40">还没有项目。点上面的「+ 新建项目」开一条管线。</div>
        )}
      </div>
    </div>
  );
}
