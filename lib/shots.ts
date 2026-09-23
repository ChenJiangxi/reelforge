import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";
import { projectAssets } from "@/lib/media";
import { TEMPLATES, TPL, type Field, type Shot } from "@/lib/shot-catalog";
export { TEMPLATES, TPL, type Field, type Shot };

// 她在网页上改镜头:存在脚本阶段 clips[i].shots(跟着这一拍走,素材阶段重跑也不覆盖),
// 只重跑剪辑。和剪辑参数覆盖(lib/overrides.ts)是同一个思路:改了就一直在、看得见、能撤销。

const clip = (s: unknown, n: number) => [...String(s ?? "")].slice(0, n).join("");

/** 规整她交上来的镜头:只留认识的模板和字段,字数截到上限的 1.5 倍(再长画面放不下) */
export function normalizeShots(raw: unknown, assetNames: string[]): Shot[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: Shot[] = [];
  for (const s of arr.slice(0, 6)) {
    if (!s || typeof s !== "object") continue;
    const x = s as Shot;
    const from = out.length ? clip(x.from, 30) : "";
    if (x.asset) {
      if (assetNames.includes(String(x.asset))) out.push({ asset: String(x.asset), from });
      continue;
    }
    const t = TPL[String(x.tpl)];
    if (!t) continue;
    const p: Record<string, unknown> = {};
    for (const f of t.fields) {
      const v = (x.p ?? {})[f.key];
      if (v == null || v === "") continue;
      p[f.key] = cleanField(f, v);
    }
    out.push({ tpl: t.id, from, p });
  }
  return out;
}

function cleanField(f: Field, v: unknown): unknown {
  const cap = (n?: number) => Math.ceil((n ?? 30) * 1.5);
  switch (f.type) {
    case "text":
      return clip(v, cap(f.max));
    case "number":
      return Number.isFinite(Number(v)) ? Number(v) : undefined;
    case "select":
      return f.options?.includes(String(v)) ? String(v) : undefined;
    case "list":
      return (Array.isArray(v) ? v : []).map((x) => clip(x, cap(f.itemMax))).filter(Boolean).slice(0, (f.max ?? 6) + 1);
    case "items":
      return (Array.isArray(v) ? v : []).slice(0, (f.max ?? 6) + 1).map((it) => {
        const o: Record<string, unknown> = {};
        for (const sub of f.of ?? []) {
          const sv = (it as Record<string, unknown>)?.[sub.key];
          if (sv != null && sv !== "") o[sub.key] = cleanField(sub, sv);
        }
        return o;
      });
    case "side": {
      const o = (v ?? {}) as { title?: unknown; lines?: unknown };
      return { title: clip(o.title, 9), lines: (Array.isArray(o.lines) ? o.lines : []).map((l) => clip(l, 15)).filter(Boolean).slice(0, 4) };
    }
    case "rows":
      return (Array.isArray(v) ? v : []).slice(0, 6).map((r) => (Array.isArray(r) ? r.map((c) => clip(c, cap(f.itemMax))) : []));
  }
  return v;
}

async function scriptOf(projectId: string) {
  const stage = await prisma.stage.findFirst({ where: { projectId, kind: "script" } });
  const art = stage?.artifacts ? JSON.parse(stage.artifacts) : {};
  const clips: { name: string; text: string; shots?: Shot[] }[] = Array.isArray(art.clips) ? art.clips : [];
  return { stage, art, clips };
}

function assetNamesOf(projectId: string) {
  return projectAssets(projectId).map((a) => a.name);
}

export async function applyShots(projectId: string, beat: string, shots: unknown | null) {
  const { stage, art, clips } = await scriptOf(projectId);
  if (!stage || !clips.length) return { ok: false as const, error: "脚本还没有分拍" };
  const i = clips.findIndex((c) => c.name === beat);
  if (i < 0) return { ok: false as const, error: `没有 ${beat} 这一拍` };
  let reason: string;
  if (shots == null) {
    if (!clips[i].shots) return { ok: true as const, summary: "这拍本来就是自动排的镜头。" };
    clips[i] = { ...clips[i], shots: undefined };
    reason = `你把 ${beat} 的镜头恢复成自动排的`;
  } else {
    const clean = normalizeShots(shots, assetNamesOf(projectId));
    if (!clean.length) return { ok: false as const, error: "至少要有一个镜头" };
    clips[i] = { ...clips[i], shots: clean };
    reason = `你改了 ${beat} 的镜头(${clean.map((s) => (s.asset ? "素材" : TPL[s.tpl!]?.label)).join(" → ")})`;
  }
  await prisma.stage.update({ where: { id: stage.id }, data: { artifacts: JSON.stringify({ ...art, clips }) } });
  const r = await requeue(projectId, { redo: ["edit"], reason });
  return { ok: true as const, summary: r.summary };
}

// ── 换一个:给某一拍的某个镜头出 3 个不同模板的候选 ────────────────────

function fieldDoc(f: Field): string {
  const opt = f.optional ? ",可省" : "";
  if (f.type === "text") return `"${f.key}": ≤${f.max}字${opt}`;
  if (f.type === "number") return `"${f.key}": 数字${opt}`;
  if (f.type === "select") return `"${f.key}": ${f.options?.join("|")}${opt}`;
  if (f.type === "list") return `"${f.key}": [${f.min}-${f.max} 个 ≤${f.itemMax}字]${opt}`;
  if (f.type === "items") return `"${f.key}": [{${(f.of ?? []).map((x) => `"${x.key}"${x.optional ? "?" : ""}`).join(",")}} ${f.min}-${f.max} 个]`;
  if (f.type === "side") return `"${f.key}": {"title":≤6字,"lines":[≤10字]}`;
  if (f.type === "rows") return `"${f.key}": [[≤${f.itemMax}字]] ${f.min}-${f.max} 行`;
  return `"${f.key}"`;
}

export async function suggestShots(projectId: string, beat: string, index: number, hint?: string, onlyTpl?: string) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false as const, error: "服务器还没配 LLM key" };
  const { clips } = await scriptOf(projectId);
  const c = clips.find((x) => x.name === beat);
  if (!c) return { ok: false as const, error: `没有 ${beat} 这一拍` };
  const footage = await prisma.stage.findFirst({ where: { projectId, kind: "footage" } });
  const fArt = footage?.artifacts ? JSON.parse(footage.artifacts) : {};
  const cur: Shot[] = c.shots ?? fArt.cards?.find((x: { name: string }) => x.name === beat)?.shots ?? [];
  const target = cur[index];
  const catalogText = TEMPLATES.map((t) => `■ ${t.id}(${t.label}):${t.use}\n   p: ${t.fields.map(fieldDoc).join(";")}`).join("\n");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    signal: AbortSignal.timeout(60_000),
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "deepseek/deepseek-v3.2",
      temperature: 0.8,
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: `你是短视频动态分镜师。${onlyTpl && TPL[onlyTpl] ? `给一个镜头用 ${onlyTpl}(${TPL[onlyTpl].label})模板填内容,出 3 个不同写法。` : "给一个镜头出 3 个不同的替代方案,每个用不同的模板。"}
屏幕上的字不是字幕:只放提炼过的关键词、术语、关系、数字,不许整句照抄台词;数字只能用台词里真有的。
模板库:
${catalogText}`,
        },
        {
          role: "user",
          content: `这拍台词:${c.text}
这拍现在的镜头:${cur.map((s, k) => `${k + 1}. ${s.asset ? `素材 ${s.asset}` : `${s.tpl} ${JSON.stringify(s.p)}`}${s.from ? `(念到「${s.from}」切)` : ""}`).join("\n")}
要换的是第 ${index + 1} 个${onlyTpl ? `,改用 ${onlyTpl} 模板` : target?.tpl ? `(现在是 ${target.tpl},换成别的模板)` : "(新加的镜头)"}。${hint ? `\n她的要求:${hint}` : ""}
返回 JSON:{"options":[{"tpl":"...","p":{...}},{...},{...}]}`,
        },
      ],
    }),
  });
  if (!r.ok) return { ok: false as const, error: `LLM 返回 ${r.status}` };
  const j = await r.json();
  const text: string = j.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  let options: Shot[] = [];
  try {
    options = normalizeShots(JSON.parse(m ? m[0] : "{}").options, []).map((s) => ({ ...s, from: target?.from ?? "" }));
  } catch {
    return { ok: false as const, error: "LLM 返回的不是合法 JSON,再点一次" };
  }
  if (!options.length) return { ok: false as const, error: "没出来候选,再点一次" };
  return { ok: true as const, options };
}
