import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";
import { CAMERA_LABELS, OVERRIDE_LABELS, describeOverride, type Overrides } from "@/lib/stages";
import type { OverrideChange } from "@/lib/direct-edit";

// 剪辑参数覆盖:存在脚本阶段 clips[i].overrides(跟着这一拍走,插句删句重新编号也不丢),
// 只重跑剪辑(字幕/润色烧在剪辑上,锁死跟着走)。网页上的开关和聊天直通车都走这里。

const KEYS: (keyof Overrides)[] = ["fit", "slow", "fill", "from", "camera"];

function clean(set: Overrides): Overrides {
  const out: Overrides = {};
  if (set.fit === "contain" || set.fit === "cover") out.fit = set.fit;
  if (set.slow != null && Number.isFinite(Number(set.slow))) out.slow = Math.min(3, Math.max(0.5, Math.round(Number(set.slow) * 100) / 100));
  if (set.fill === "pingpong" || set.fill === "freeze" || set.fill === "loop") out.fill = set.fill;
  if (set.from != null && Number.isFinite(Number(set.from))) out.from = Math.min(600, Math.max(0, Math.round(Number(set.from) * 10) / 10));
  if (set.camera && String(set.camera) in CAMERA_LABELS) out.camera = String(set.camera);
  return out;
}

export async function applyOverrides(
  projectId: string,
  changes: OverrideChange[],
  opts: { announce?: boolean } = {},
): Promise<{ ok: boolean; error?: string; described: string[]; summary: string }> {
  const scriptStage = await prisma.stage.findFirst({ where: { projectId, kind: "script" } });
  const art = scriptStage?.artifacts ? JSON.parse(scriptStage.artifacts) : {};
  const clips: { name: string; overrides?: Overrides }[] = Array.isArray(art.clips) ? art.clips : [];
  if (!scriptStage || !clips.length) return { ok: false, error: "脚本还没有分拍", described: [], summary: "" };

  const described: string[] = [];
  for (const ch of changes) {
    const i = clips.findIndex((c) => c.name === ch.clip);
    if (i < 0) return { ok: false, error: `没有 ${ch.clip} 这一拍`, described: [], summary: "" };
    const cur: Overrides = { ...(clips[i].overrides ?? {}) };
    const parts: string[] = [];
    if (ch.unset === "all") {
      if (Object.keys(cur).length) parts.push("剪辑参数全部恢复成自动");
      for (const k of KEYS) delete cur[k];
    } else if (Array.isArray(ch.unset)) {
      for (const k of ch.unset) {
        if (cur[k] != null) parts.push(`${OVERRIDE_LABELS[k]}恢复成自动`);
        delete cur[k];
      }
    }
    if (ch.set) {
      const s = clean(ch.set);
      for (const k of Object.keys(s) as (keyof Overrides)[]) {
        (cur as Record<string, unknown>)[k] = s[k];
        parts.push(`${OVERRIDE_LABELS[k]} → ${describeOverride(k, s[k])}`);
      }
    }
    clips[i] = { ...clips[i], overrides: Object.keys(cur).length ? cur : undefined };
    if (parts.length) described.push(`${ch.clip}:${parts.join(",")}`);
  }
  if (!described.length) return { ok: true, described, summary: "没有要改的参数。" };

  await prisma.stage.update({
    where: { id: scriptStage.id },
    data: { artifacts: JSON.stringify({ ...art, clips }) },
  });
  const r = await requeue(projectId, {
    redo: ["edit"],
    reason: `你改了剪辑参数(${described.join(";")})`,
    announce: opts.announce,
  });
  return { ok: true, described, summary: r.summary };
}
