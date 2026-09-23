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
    <div className="max-w-5xl">
      <div className="relative mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">项目</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            agent 在后台推进，卡在审核门等你。点开审。
          </p>
        </div>
        <NewProjectButton />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => {
          const ordered = [...p.stages].sort((a, b) => a.order - b.order);
          const done = ordered.filter((s) => s.status === "approved").length;
          const total = ordered.length || 1;
          // 失败停放的阶段要一眼看出来:以前卡片只写"当前:剪辑",看不出它其实已经挂了
          const failed = ordered.find(
            (s) => s.status === "changes_requested" && /"failure"|"note":"FAILED:/.test(s.artifacts ?? ""),
          );
          const current =
            failed ??
            ordered.find((s) => s.status === "awaiting_review") ??
            ordered.find((s) => s.status === "working") ??
            ordered.find((s) => s.status !== "approved");
          return (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="group rounded-lg bg-card p-4 hover:bg-muted/70"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {p.platform}
                </span>
                <StatusBadge status={p.status} />
              </div>
              <div className="mb-3 text-sm font-medium leading-snug">{p.title}</div>
              {/* pipeline progress */}
              <div className="mb-2.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-foreground/70 transition-all"
                  style={{ width: `${Math.round((done / total) * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {current ? `当前:${stageLabel(current.kind)}` : "已完成"}
                  {failed ? (
                    <span className="ml-1 font-medium text-destructive">· 没做成,点开看卡在哪</span>
                  ) : current?.status === "awaiting_review" ? (
                    <span className="ml-1 font-medium text-accent">· 待你审</span>
                  ) : current?.status === "working" ? (
                    <span className="ml-1">· 制作中</span>
                  ) : null}
                </span>
                <span className="font-mono tabular-nums">
                  {done}/{total}
                </span>
              </div>
            </Link>
          );
        })}
        {projects.length === 0 && (
          <div className="col-span-full rounded-lg bg-muted/40 px-6 py-16 text-center">
            <div className="mb-1 text-sm font-medium">还没有项目</div>
            <div className="text-sm text-muted-foreground">
              点右上角「+ 新建项目」，一句话说清主题，剩下的交给管线。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
