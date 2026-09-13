import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { STAGE_ORDER } from "@/lib/stages";

// POST /api/project/[id]/assign { clip, asset } — drag-and-drop assignment:
// 素材拖到某拍上 = 那拍画面换成它。确定性操作,不过 LLM。
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { clip, asset } = await req.json().catch(() => ({}));
  const clipName = String(clip ?? "");
  const assetName = String(asset ?? "");
  if (!clipName || !assetName) return NextResponse.json({ error: "clip + asset required" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scriptStage = project.stages.find((s) => s.kind === "script");
  const art = scriptStage?.artifacts ? JSON.parse(scriptStage.artifacts) : {};
  const clips = Array.isArray(art.clips) ? [...art.clips] : [];
  const i = clips.findIndex((c: { name: string }) => c.name === clipName);
  if (i < 0) return NextResponse.json({ error: `no clip ${clipName}` }, { status: 404 });

  clips[i] = { ...clips[i], asset: assetName };
  await prisma.stage.update({
    where: { id: scriptStage!.id },
    data: { artifacts: JSON.stringify({ ...art, clips }) },
  });

  const fromOrder = STAGE_ORDER.indexOf("footage");
  // 连 working 中的阶段也翻回 pending:submit 的竞态守卫会作废它按旧输入产出的结果
    for (const s of project.stages) {
    if (s.order >= fromOrder) {
      await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
    }
  }
  await prisma.project.update({ where: { id }, data: { status: "producing" } });
  await prisma.message.create({
    data: { projectId: id, role: "agent", text: `第 ${i + 1} 拍画面换成「${assetName}」。画面/剪辑/字幕重出中,好了喊你审。` },
  });
  return NextResponse.json({ ok: true });
}
