import { prisma } from "@/lib/db";
import { PlaybookEditor } from "@/components/PlaybookEditor";
import { STAGE_LABELS, type Comment } from "@/lib/stages";

export const dynamic = "force-dynamic";

const PLAYBOOKS: { name: string; title: string; stage: string; desc: string }[] = [
  { name: "topic", title: "选题教案", stage: "topic", desc: "想法 → 角度+钩子+不吹清单" },
  { name: "script", title: "脚本教案", stage: "script", desc: "叙事弧线 + 句间连贯 + 分拍" },
  { name: "critique", title: "审稿教案", stage: "script", desc: "主编二稿清单(脚本的质检员)" },
  { name: "visual", title: "画面教案", stage: "footage", desc: "卡型/信息量/主题/封面规矩" },
  { name: "voice", title: "配音教案", stage: "voice", desc: "每拍的语速/音高/停顿——决定片子平不平" },
];

export default async function PlaybooksPage() {
  // 每个阶段的近期打回批注——和教案摆同屏,她的反馈就是教案的迭代方向
  const rejected = await prisma.stage.findMany({
    where: { comments: { not: null } },
    select: { kind: true, comments: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });
  const notesByStage: Record<string, string[]> = {};
  for (const s of rejected) {
    const comments: Comment[] = JSON.parse(s.comments || "[]");
    for (const c of comments) {
      if (c.decision !== "reject") continue;
      (notesByStage[s.kind] ??= []).push(c.text);
    }
  }
  for (const k of Object.keys(notesByStage)) notesByStage[k] = notesByStage[k].slice(0, 6);

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">教案</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          每个阶段的「做法」都在这,改完保存,worker 一分钟内拿到新版——下一条片就按新教案做。右边是这个阶段最近被打回的批注,就是教案的迭代方向。
        </p>
      </div>
      <div className="space-y-6">
        {PLAYBOOKS.map((p) => (
          <PlaybookEditor key={p.name} name={p.name} title={p.title} desc={p.desc} notes={notesByStage[p.stage] ?? []} stageLabel={STAGE_LABELS[p.stage]} />
        ))}
      </div>
    </div>
  );
}
