import { NextRequest, NextResponse } from "next/server";
import { readdirSync } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { parseChat, applyOps, type Clip, type ChatOp } from "@/lib/chat-ops";
import { resolveStage } from "@/lib/resolve-stage";
import { requeue } from "@/lib/rerun";
import { applyOverrides } from "@/lib/overrides";
import { parseDirect, type BeatKind } from "@/lib/direct-edit";
import { STAGE_ORDER, stageLabel, type Decision, type Overrides } from "@/lib/stages";
import { MEDIA_DIR } from "@/lib/media";

function projectAssets(projectId: string): { name: string; kind: string }[] {
  const read = (id: string) => {
    const dir = path.join(MEDIA_DIR, id, "assets");
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { return []; }
    return files
      .filter((f) => /\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif)$/i.test(f))
      .map((f) => ({ name: f, kind: /\.(mp4|mov|webm|m4v)$/i.test(f) ? "video" : "image" }));
  };
  return [...read(projectId), ...read("_global")];
}

// LLM 给的阶段名只用来"预填"重做表单,不再直接执行 —— 她在表单上看得见要重做的是哪一步,
// 点了才算。2026-09-16「素材重出」被判成了配音,错在她刚要求过别动的那件事上。
const KIND_RULES: [RegExp, string][] = [
  [/封面|文案|发布|话题|hashtag|打包|下载|cover|caption/i, "deliver"],
  [/字幕|subtitle/i, "subtitles"],
  [/剪辑|节奏|剪接|edit/i, "edit"],
  [/配音|音色|声音|语速|旁白|voice/i, "voice"],
  [/素材|画面|字卡|卡片|footage|card/i, "footage"],
  [/脚本|台词|口播稿|script/i, "script"],
  [/选题|角度|钩子|topic/i, "topic"],
];

function normalizeKind(kind: unknown): string | null {
  const k = String(kind ?? "").toLowerCase();
  if ((STAGE_ORDER as readonly string[]).includes(k)) return k;
  for (const [re, target] of KIND_RULES) if (re.test(k)) return target;
  return null;
}

// POST /api/project/[id]/chat { text } — the 对话剪辑 endpoint.
// 顺序:① 直通车(「c01 别裁,慢一点」→ 参数覆盖,不过 LLM)② 审核门上的"过了/打回"
// ③ 逐拍改稿(改词/删句/插句/改念法/换画面)④ 整阶段重做 → 只返回建议,前端打开重做表单。
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text } = await req.json().catch(() => ({}));
  const said = String(text ?? "").trim();
  if (!said) return NextResponse.json({ error: "empty" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.message.create({ data: { projectId: id, role: "user", text: said } });
  const say = async (reply: string, extra: Record<string, unknown> = {}) => {
    await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
    return NextResponse.json({ ok: true, reply, ...extra });
  };

  const artOf = (kind: string) => {
    const s = project.stages.find((x) => x.kind === kind);
    return s?.artifacts ? JSON.parse(s.artifacts) : {};
  };
  const scriptStage = project.stages.find((s) => s.kind === "script");
  const scriptArt = artOf("script");
  const clips: (Clip & { overrides?: Overrides })[] = Array.isArray(scriptArt.clips) ? scriptArt.clips : [];
  const awaiting = project.stages.find((s) => s.status === "awaiting_review") ?? null;
  const assets = projectAssets(id);
  const footageArt = artOf("footage");
  const cards: { name: string; text?: string; type?: string; theme?: string; asset?: string; anim?: string }[] =
    Array.isArray(footageArt.cards) ? footageArt.cards : [];

  // ── ① 直通车 ──
  const kindOf = (clip: string): BeatKind | undefined => {
    const c = cards.find((x) => x.name === clip);
    const asset = c?.asset ?? clips.find((x) => x.name === clip)?.asset;
    if (asset) return assets.find((a) => a.name === asset)?.kind === "video" ? "video" : "image";
    if (!c) return undefined;
    return c.anim ? "anim" : "card";
  };
  const editDecisions: Decision[] = Array.isArray(artOf("edit").decisions) ? artOf("edit").decisions : [];
  const direct = clips.length
    ? parseDirect(said, clips, {
        kindOf,
        current: (clip, key) =>
          clips.find((c) => c.name === clip)?.overrides?.[key] ??
          editDecisions.find((d) => d.beat === clip && d.key === key)?.value,
      })
    : null;
  if (direct && (direct.changes.length || direct.problems.length)) {
    const r = direct.changes.length ? await applyOverrides(id, direct.changes, { announce: false }) : null;
    const lines: string[] = [];
    if (r?.ok && r.described.length) {
      lines.push(`记下了,挂在这一拍上,以后每次重剪都按这个来:${r.described.join(";")}。`);
      lines.push(r.summary.replace(/^你改了剪辑参数\([^)]*\)。/, ""));
    } else if (r && !r.ok) lines.push(`没改成:${r.error}`);
    else if (r) lines.push("这几拍已经是这样设的,没有变化。");
    if (direct.problems.length) lines.push(`没法设:${direct.problems.join(";")}。`);
    if (direct.leftover) lines.push(`「${direct.leftover}」这部分我没认出来,没动;要改的话单独说一句。`);
    return say(lines.filter(Boolean).join("\n"));
  }

  // 她问"右边这是什么"时,agent 必须答得出——把当前画面真实状态喂给它
  const cardsCtx = cards
    .map((c, i) => `图${i + 1}(${c.name}):${c.asset ? `素材「${c.asset}」` : `${c.type ?? "?"}卡/${c.theme ?? "?"}底`} — 台词"${(c.text ?? "").slice(0, 24)}"`)
    .join("\n");
  const stateCtx = [
    awaiting ? `右边正在审:${stageLabel(awaiting.kind)}` : "右边没有待审的东西",
    cardsCtx ? `素材阶段每拍实际用的画面:\n${cardsCtx}` : "",
  ].filter(Boolean).join("\n");

  let parsed;
  try {
    parsed = await parseChat(said, clips, project, awaiting ? { kind: awaiting.kind, label: stageLabel(awaiting.kind) } : null, assets, stateCtx);
  } catch (e) {
    return say(`解析失败(${e instanceof Error ? e.message : "LLM 错误"}),你的消息我记下了,稍后再试。`);
  }

  // ── ② 审核门:她的话就是结论 ──
  const reviewOp = parsed.ops.find((o): o is Extract<ChatOp, { action: "review" }> => o.action === "review");
  if (reviewOp && awaiting) {
    const ok = await resolveStage(
      awaiting.id,
      reviewOp.decision,
      reviewOp.decision === "reject" ? reviewOp.note || said : undefined,
    );
    if (ok) {
      // 打回时 requeue 已经把"重做谁、谁跟着重出"发进聊天了,这里不再重复
      if (reviewOp.decision === "reject") return NextResponse.json({ ok: true, reply: "" });
      return say(`「${stageLabel(awaiting.kind)}」过了,agent 接着做下一阶段。`);
    }
  }

  // ── ③ 逐拍改稿 ──
  const assetNames = new Set(assets.map((a) => a.name));
  const clipOps = parsed.ops.filter((o) =>
    o.action === "assign_asset" ? assetNames.has(o.asset) : !["reply", "redo_stage", "review"].includes(o.action),
  );
  const redoOps = parsed.ops.filter((o): o is Extract<ChatOp, { action: "redo_stage" }> => o.action === "redo_stage");
  let rerunSummary = "";

  if (clipOps.length && clips.length && scriptStage) {
    const { clips: next, voiceDirty, footageDirty, textChanged, beatCountChanged } = applyOps(clips, clipOps);
    await prisma.stage.update({
      where: { id: scriptStage.id },
      data: { artifacts: JSON.stringify({ ...scriptArt, clips: next, script: next.map((c) => c.text).join("\n") }) },
    });
    // 改的是什么就重跑什么:台词变了 = 脚本变了(配音锁死、画面和文案可选);
    // 只改念法 = 只重做配音;只改画面 = 只重做素材。
    const r = await requeue(id, {
      changed: textChanged ? ["script"] : [],
      redo: [...(footageDirty && !textChanged ? ["footage"] : []), ...(voiceDirty && !textChanged ? ["voice"] : [])],
      beatCountChanged,
      reason: "按你说的改了稿",
      announce: false,
    });
    rerunSummary = r.summary.replace(/^按你说的改了稿。/, "");
  }

  // ── ④ 整阶段重做:不执行,只把建议交给前端打开重做表单 ──
  let suggest: { kind: string; note: string } | null = null;
  for (const op of redoOps) {
    const kind = normalizeKind(op.kind);
    if (kind && project.stages.some((s) => s.kind === kind)) {
      suggest = { kind, note: op.note || said };
      break;
    }
  }

  const base =
    parsed.reply ||
    (clipOps.length ? "按你说的改了。" : suggest ? "" : "这句我没看出要改什么,换个说法,或者直接在右边点那一步的「重做」。");
  const tail = [
    rerunSummary,
    suggest ? `要重做「${stageLabel(suggest.kind)}」的话,右边已经打开了重做表:先确认是不是这一步、要跟着重出哪些,再提交。` : "",
  ].filter(Boolean);
  return say([base, ...tail].filter(Boolean).join("\n"), suggest ? { suggest } : {});
}
