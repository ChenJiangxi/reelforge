import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { STAGE_ORDER, type Artifacts } from "@/lib/stages";

// POST /api/project/[id]/voice-take { take: "a" | "b" }
// 配音阶段出两版念法,她听完点一个。选 B = 把 B 的时间轴换成主时间轴,
// 并把这版的念法写回脚本 —— 之后任何一次重出都按她选的方向念,不会打回原形。
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const take: "a" | "b" = body?.take === "b" ? "b" : body?.take === "a" ? "a" : ("" as never);
  if (take !== "a" && take !== "b") return NextResponse.json({ error: "take must be a or b" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const voiceStage = project.stages.find((s) => s.kind === "voice");
  if (!voiceStage) return NextResponse.json({ error: "no voice stage" }, { status: 404 });
  const art = (voiceStage.artifacts ? JSON.parse(voiceStage.artifacts) : {}) as Artifacts;
  if (!art.takes) return NextResponse.json({ error: "这条片的配音只有一版" }, { status: 400 });

  const chosen = art.takes[take];
  if (!chosen) return NextResponse.json({ error: "这一版不存在" }, { status: 400 });
  const switching = (art.takes.picked ?? "a") !== take;
  if (switching && !art.voiceMetaAlt) return NextResponse.json({ error: "备选版本的时间轴丢了,请打回重出配音" }, { status: 400 });

  // A/B 两栏的位置固定不动(她记得住"A 是稳一点"),换版只换主时间轴。
  // voiceMeta 和 voiceMetaAlt 对调而不是丢弃 —— 她可以再点回来。
  const next: Artifacts = {
    ...art,
    audio: chosen.audio,
    wave: chosen.wave,
    voiceMeta: switching ? art.voiceMetaAlt! : art.voiceMeta,
    voiceMetaAlt: switching ? art.voiceMeta : art.voiceMetaAlt,
    takes: { ...art.takes, picked: take },
  };

  await prisma.stage.update({
    where: { id: voiceStage.id },
    data: { status: "approved", artifacts: JSON.stringify(next) },
  });

  // 念法写回脚本:下一次重出(改一句话、换个画面)不会把她选的方向丢掉
  const scriptStage = project.stages.find((s) => s.kind === "script");
  if (scriptStage && switching) {
    const sArt = scriptStage.artifacts ? JSON.parse(scriptStage.artifacts) : {};
    const byName = new Map((next.voiceMeta?.clips ?? []).map((c) => [c.name, c]));
    if (Array.isArray(sArt.clips)) {
      sArt.clips = sArt.clips.map((c: { name: string; say?: unknown; tts?: string }) => {
        const m = byName.get(c.name);
        if (!m?.say) return c;
        return { ...c, say: { speed: m.say.speedRel ?? 1, pitch: m.say.pitch, emotion: m.say.emotion ?? undefined, gap_after: m.say.gap_after ?? m.gap } };
      });
      await prisma.stage.update({ where: { id: scriptStage.id }, data: { artifacts: JSON.stringify(sArt) } });
    }
  }

  // 下游重出(保留旧产物:新版渲染期间旧成片还能看)
  const fromOrder = STAGE_ORDER.indexOf("edit");
  for (const s of project.stages) {
    if (s.order >= fromOrder) await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
  }
  await prisma.project.update({ where: { id }, data: { status: "producing" } });
  await prisma.message.create({
    data: {
      projectId: id,
      role: "agent",
      text: `配音用「${art.takes[take]?.label ?? take.toUpperCase()}」这版定了,剪辑/字幕重出中,好了喊你审。`,
    },
  });
  return NextResponse.json({ ok: true });
}
