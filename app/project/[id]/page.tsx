import Link from "next/link";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { AssetBar, type Asset } from "@/components/AssetBar";
import { projectAssets } from "@/lib/media";
import { beatTimeline, insertSpans } from "@/lib/timeline";
import type { TlBeat, TlInsert } from "@/components/Timeline";
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


  // 素材库(录屏/图片),扫盘得来:项目素材 + 全局共享素材,都可拖到节拍上
  const assets: Asset[] = projectAssets(project.id);

  // 每拍是什么画面(决定清单里的运镜选项按它给)+ 她挂在这拍上的剪辑参数
  const kindOf = (name: string, asset?: string): ClipThumb["kind"] => {
    const card = footage.cards?.find((c) => c.name === name) as { asset?: string; anim?: string } | undefined;
    const a = card?.asset ?? asset;
    if (a) return assets.find((x) => x.name === a)?.kind === "video" ? "video" : "image";
    if (!card) return undefined;
    return card.anim ? "anim" : "card";
  };
  // 时间轴:剪辑跑过且设置没变就用它的;否则按配音 + 现在的停顿/插入设置算(改了立刻看得到)
  const voiceClips = voice.voiceMeta?.clips ?? [];
  const scriptClips = script.clips ?? [];
  const editArt = artOf("edit");
  const tl = beatTimeline(voiceClips, editArt, scriptClips);
  const tlOf = new Map(tl.map((b) => [b.name, b]));
  const clips: ClipThumb[] = scriptClips.map((c, i) => ({
    name: c.name,
    text: c.text,
    image: footage.images?.[i],
    dur: tlOf.get(c.name)?.dur ?? voiceClips[i]?.dur,
    gap: tlOf.get(c.name)?.gap ?? voiceClips[i]?.gap,
    kind: kindOf(c.name, c.asset),
    overrides: c.overrides,
  }));
  const voiceStarts = voiceClips.reduce<number[]>((acc, v, i) => [...acc, i ? acc[i - 1] + voiceClips[i - 1].dur + (voiceClips[i - 1].gap ?? 0.18) : 0], []);
  const vAt = voiceClips.length ? voiceStarts[voiceStarts.length - 1] + voiceClips[voiceClips.length - 1].dur + (voiceClips[voiceClips.length - 1].gap ?? 0.18) : 0;
  const tlBeats: TlBeat[] = tl.map((b, i) => {
    const c = scriptClips.find((x) => x.name === b.name);
    const baseGap = c?.overrides?.gap ?? voiceClips[i]?.gap ?? 0.18;
    return { ...b, text: c?.text ?? "", image: footage.images?.[i], baseGap, gapOverridden: c?.overrides?.gap != null, voiceStart: voiceStarts[i] ?? 0 };
  });
  // 插入:剪辑已经按现在的设置渲过就用它算出来的真实位置;刚改、还没重剪的标成"等重剪"
  const spans = insertSpans(tl, voiceClips, scriptClips);
  const rendered = new Map((editArt.inserts ?? []).map((x) => [x.id, x]));
  const tlInserts: TlInsert[] = spans.map((x) => {
    const r = rendered.get(x.id);
    return r
      ? { id: x.id, asset: x.asset, kind: x.kind, mode: x.mode, clip: x.clip, start: r.start, end: r.end }
      : { id: x.id, asset: x.asset, kind: x.kind, mode: x.mode, clip: x.clip, start: x.start, end: x.end, pending: true };
  });

  return (
    <div className="project-shell max-w-[1600px]">
      {/* 头部一行:返回 + 标题 + 状态 + 设置 + 素材入口,全在一行,不占工作区 */}
      <div className="mb-1.5 flex shrink-0 items-center gap-3">
        <Link href="/" className="shrink-0 text-sm text-muted-foreground hover:text-foreground">←</Link>
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
        tlBeats={tlBeats}
        tlInserts={tlInserts}
        voiceTotal={vAt}
      />
    </div>
  );
}
