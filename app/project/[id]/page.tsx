import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { StageCard } from "@/components/StageCard";
import { StatusBadge } from "@/components/StatusBadge";
import { ChatPanel } from "@/components/ChatPanel";
import { PreviewPane, type ClipThumb } from "@/components/PreviewPane";
import { stageLabel, type Artifacts } from "@/lib/stages";

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
    include: {
      stages: { orderBy: { order: "asc" } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!project) notFound();

  const settings = [
    project.platform === "bilibili" ? "B站横版" : "抖音竖版",
    project.aspect,
    project.voice === "clone-zh" ? "克隆音·中文" : "英文旁白",
    project.bgm === "yes" ? "带 BGM" : "无 BGM",
    `~${project.duration}s`,
  ];

  const artOf = (kind: string): Artifacts => {
    const s = project.stages.find((x) => x.kind === kind);
    return s?.artifacts ? JSON.parse(s.artifacts) : {};
  };
  const script = artOf("script");
  const footage = artOf("footage");
  const voice = artOf("voice");
  const edit = artOf("edit");
  const subs = artOf("subtitles");
  const polish = artOf("polish");

  const video = polish.video || subs.video || edit.video;
  const clips: ClipThumb[] = (script.clips ?? []).map(
    (c: { name: string; text: string }, i: number) => ({
      name: c.name,
      text: c.text,
      image: footage.images?.[i],
      dur: voice.voiceMeta?.clips?.[i]?.dur,
    }),
  );
  const awaiting = project.stages.find((s) => s.status === "awaiting_review");
  const review: import("@/components/PreviewPane").ReviewTarget | null = awaiting
    ? { stageId: awaiting.id, kind: awaiting.kind, artifacts: awaiting.artifacts ? JSON.parse(awaiting.artifacts) : {} }
    : null;

  // "制作中" context for the preview banner: which stage is being redone and why
  // (why = her latest chat message, or the reject note that triggered it).
  const workingStage = project.stages.find((s) => s.status === "working") ?? null;
  const lastUserMsg = [...project.messages].reverse().find((m) => m.role === "user");
  let workingReason: string | null = null;
  if (workingStage) {
    const comments: { ts: number; text: string; decision: string }[] = workingStage.comments
      ? JSON.parse(workingStage.comments)
      : [];
    workingReason = comments.filter((c) => c.decision === "reject").at(-1)?.text ?? lastUserMsg?.text ?? null;
  }

  return (
    <div className="max-w-6xl">
      <a href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← 项目
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

      {/* pipeline stepper */}
      <div className="mb-5 flex items-center rounded-lg border border-border bg-card px-4 py-3">
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

      {/* editor: chat + preview */}
      <div className="editor-grid">
        <div className="order-2 lg:order-1">
          <ChatPanel projectId={project.id} messages={project.messages.map((m) => ({ role: m.role, text: m.text, ts: m.createdAt.getTime() }))} />
        </div>
        <div className="order-1 lg:order-2">
          <PreviewPane
            video={video}
            clips={clips}
            aspect={project.aspect}
            audio={voice.audio}
            wave={voice.wave}
            review={review}
            working={workingStage ? { kind: workingStage.kind, reason: workingReason } : null}
          />
        </div>
      </div>

      {/* stage history (archived artifacts + comment trail) */}
      <details className="group rounded-lg border border-border bg-card/60 open:bg-transparent">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground">
          阶段记录
          <span className="ml-2 text-xs font-normal text-muted-foreground/60">产物历史与批注轨迹</span>
          <span className="ml-2 text-xs text-muted-foreground/60 group-open:hidden">展开 ↓</span>
          <span className="ml-2 hidden text-xs text-muted-foreground/60 group-open:inline">收起 ↑</span>
        </summary>
        <div className="space-y-3 px-1 pb-1 pt-2 md:px-2">
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
      </details>
    </div>
  );
}
