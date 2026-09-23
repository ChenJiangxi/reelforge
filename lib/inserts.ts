import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";
import { projectAssets } from "@/lib/media";
import { beatTimeline, locate } from "@/lib/timeline";
import type { Artifacts, Insert } from "@/lib/stages";

// 时间轴上插入素材:存在脚本阶段 clips[i].inserts(跟着这一拍走),只重跑剪辑。
type Clip = { name: string; text: string; overrides?: { gap?: number }; inserts?: Insert[] };

async function load(projectId: string) {
  const stages = await prisma.stage.findMany({ where: { projectId } });
  const art = (k: string) => {
    const s = stages.find((x) => x.kind === k);
    return (s?.artifacts ? JSON.parse(s.artifacts) : {}) as Artifacts & Record<string, unknown>;
  };
  const scriptStage = stages.find((s) => s.kind === "script");
  const script = art("script");
  const clips = (Array.isArray(script.clips) ? script.clips : []) as Clip[];
  const voiceClips = (art("voice").voiceMeta?.clips ?? []) as { name: string; dur: number; gap?: number; words?: [string, number, number][] }[];
  const tl = beatTimeline(voiceClips, art("edit"), clips);
  return { scriptStage, script, clips, voiceClips, tl };
}

export type InsertOp =
  | { op: "add"; t?: number; after?: string; asset: string; kind?: "overlay" | "gap"; mode?: "full" | "pip"; dur?: number }
  | { op: "update"; id: string; t?: number; dur?: number; mode?: "full" | "pip" }
  | { op: "remove"; id: string };

export async function applyInsert(projectId: string, body: InsertOp): Promise<{ ok: boolean; error?: string; summary?: string }> {
  const { scriptStage, script, clips, voiceClips, tl } = await load(projectId);
  if (!scriptStage || !clips.length) return { ok: false, error: "脚本还没有分拍" };
  if (!voiceClips.length) return { ok: false, error: "配音还没出来,时间轴上还没有时间可以对" };
  let what = "";

  const where = (id: string) => {
    for (const c of clips) {
      const i = (c.inserts || []).findIndex((x) => x.id === id);
      if (i >= 0) return { c, i };
    }
    return null;
  };

  if (body.op === "add") {
    const asset = projectAssets(projectId).find((a) => a.name === body.asset);
    if (!asset) return { ok: false, error: `素材库里没有「${body.asset}」` };
    const dur = Math.min(30, Math.max(0.5, Number(body.dur) || 3));
    const kind = body.kind === "gap" ? "gap" : "overlay";
    let clip: Clip | undefined;
    const ins: Insert = { id: randomUUID().slice(0, 8), asset: asset.name, kind, mode: body.mode === "pip" ? "pip" : "full", dur };
    if (kind === "gap") {
      clip = clips.find((c) => c.name === body.after);
      if (!clip) return { ok: false, error: `没有 ${body.after} 这一拍` };
      what = `在 ${clip.name} 后面插了 ${dur}s 纯画面「${asset.name}」`;
    } else {
      const loc = locate(Number(body.t) || 0, tl, voiceClips);
      clip = clips.find((c) => c.name === loc.name);
      if (!clip) return { ok: false, error: "这个时间点找不到对应的拍" };
      ins.anchor = loc.anchor;
      ins.offset = Number(loc.local.toFixed(2));
      what = `在 ${clip.name}${loc.anchor ? ` 念到「${loc.anchor.text}」` : ""}的地方插了 ${dur}s「${asset.name}」(${ins.mode === "pip" ? "画中画" : "全屏"})`;
    }
    clip.inserts = [...(clip.inserts || []), ins];
  } else if (body.op === "update") {
    const w = where(body.id);
    if (!w) return { ok: false, error: "这个插入已经不在了" };
    const cur = { ...w.c.inserts![w.i] };
    if (body.dur != null) cur.dur = Math.min(30, Math.max(0.5, Number(body.dur)));
    if (body.mode === "full" || body.mode === "pip") cur.mode = body.mode;
    if (body.t != null && cur.kind === "overlay") {
      // 挪位置:按新的时间点重新找"念到哪个字",可能挪到了另一拍
      const loc = locate(Number(body.t), tl, voiceClips);
      cur.anchor = loc.anchor;
      cur.offset = Number(loc.local.toFixed(2));
      w.c.inserts!.splice(w.i, 1);
      const target = clips.find((c) => c.name === loc.name) ?? w.c;
      target.inserts = [...(target.inserts || []), cur];
      what = `把「${cur.asset}」挪到 ${target.name}${loc.anchor ? ` 念到「${loc.anchor.text}」` : ""}的地方`;
    } else {
      w.c.inserts![w.i] = cur;
      what = `把「${cur.asset}」改成 ${cur.mode === "pip" ? "画中画" : cur.kind === "gap" ? "纯画面" : "全屏"} ${cur.dur}s`;
    }
  } else if (body.op === "remove") {
    const w = where(body.id);
    if (!w) return { ok: false, error: "这个插入已经不在了" };
    const [gone] = w.c.inserts!.splice(w.i, 1);
    what = `删掉了插在 ${w.c.name} 的「${gone.asset}」`;
  } else {
    return { ok: false, error: "不认识的操作" };
  }

  await prisma.stage.update({ where: { id: scriptStage.id }, data: { artifacts: JSON.stringify({ ...script, clips }) } });
  const r = await requeue(projectId, { redo: ["edit"], reason: `你${what}` });
  return { ok: true, summary: r.summary };
}
