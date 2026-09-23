import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";

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

  // 换一拍的画面而已 —— 配音不用动。依赖怎么走交给 requeue,聊天里会列出重做了哪些。
  await requeue(id, { redo: ["footage"], reason: `第 ${i + 1} 拍画面换成「${assetName}」` });
  return NextResponse.json({ ok: true });
}
