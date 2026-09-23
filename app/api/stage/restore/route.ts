import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";
import { RESTORABLE, stageLabel, type Version } from "@/lib/stages";

// POST /api/stage/restore { stageId, v } —— 退回某一步的某一版
// - 剪辑:把那一版当时的参数(每拍覆盖、插入、音效开关)放回去重剪;按拍缓存,出来就是那一版
// - 脚本:把那一版的稿子放回去,下游按依赖重出
// - 字幕 / 润色 / 交付:直接换回那一版的产物,等你再审
// 配音、素材的中间文件每次都会被覆盖,只能看、不能退(界面上不给按钮)

export async function POST(req: NextRequest) {
  const { stageId, v } = await req.json().catch(() => ({}));
  const stage = await prisma.stage.findUnique({ where: { id: String(stageId ?? "") } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!RESTORABLE.has(stage.kind)) return NextResponse.json({ error: `「${stageLabel(stage.kind)}」的旧版只能看,不能退回` }, { status: 400 });
  const art = stage.artifacts ? JSON.parse(stage.artifacts) : {};
  const hist: Version[] = Array.isArray(art.history) ? art.history : [];
  const ver = hist.find((h) => h.v === Number(v));
  if (!ver) return NextResponse.json({ error: "这一版已经不在历史里了" }, { status: 404 });
  const label = stageLabel(stage.kind);
  const reason = `你退回了「${label}」v${ver.v}`;

  if (stage.kind === "edit") {
    if (!ver.settings) return NextResponse.json({ error: "这一版没记下当时的参数,退不回去" }, { status: 400 });
    const scriptStage = await prisma.stage.findFirst({ where: { projectId: stage.projectId, kind: "script" } });
    if (!scriptStage) return NextResponse.json({ error: "没有脚本阶段" }, { status: 400 });
    const sArt = scriptStage.artifacts ? JSON.parse(scriptStage.artifacts) : {};
    sArt.clips = (Array.isArray(sArt.clips) ? sArt.clips : []).map((c: { name: string }) => {
      const s = ver.settings!.perClip[c.name] as { overrides?: unknown; inserts?: unknown } | undefined;
      return { ...c, overrides: s?.overrides, inserts: s?.inserts };
    });
    sArt.editSettings = ver.settings.editSettings;
    await prisma.stage.update({ where: { id: scriptStage.id }, data: { artifacts: JSON.stringify(sArt) } });
    const r = await requeue(stage.projectId, { redo: ["edit"], reason });
    return NextResponse.json({ ok: true, summary: r.summary });
  }

  if (stage.kind === "script") {
    if (!ver.clips) return NextResponse.json({ error: "这一版没记下分拍,退不回去" }, { status: 400 });
    await prisma.stage.update({
      where: { id: stage.id },
      data: { status: "approved", artifacts: JSON.stringify({ ...art, script: ver.script, clips: ver.clips }) },
    });
    const r = await requeue(stage.projectId, { changed: ["script"], reason });
    return NextResponse.json({ ok: true, summary: r.summary });
  }

  // 字幕 / 润色 / 交付:换回那一版的产物,等你再审;下游按依赖重出
  const next = { ...art };
  for (const k of ["video", "audio", "wave", "cover", "caption"] as const) if (ver[k] !== undefined) next[k] = ver[k];
  delete next.master; // 那一版的高清母版不一定还在渲染机上,下一步会退回用预览并说明
  await prisma.stage.update({ where: { id: stage.id }, data: { status: "awaiting_review", artifacts: JSON.stringify(next) } });
  const r = await requeue(stage.projectId, { changed: [stage.kind], reason });
  return NextResponse.json({ ok: true, summary: r.summary });
}
