import { NextRequest, NextResponse } from "next/server";
import { readdirSync } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { parseChat, applyOps, type Clip, type ChatOp } from "@/lib/chat-ops";
import { resolveStage } from "@/lib/resolve-stage";
import { STAGE_ORDER, stageLabel } from "@/lib/stages";
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

// Never trust the LLM's stage name — map by what the instruction is ABOUT.
// Note text wins over the raw kind ("封面" → deliver even if it said "topic").
const KIND_RULES: [RegExp, string][] = [
  [/封面|文案|发布|话题|hashtag|打包|下载|cover|caption/i, "deliver"],
  [/字幕|subtitle/i, "subtitles"],
  [/剪辑|节奏|剪接|edit/i, "edit"],
  [/配音|音色|声音|语速|旁白|voice/i, "voice"],
  [/素材|画面|字卡|卡片|footage|card/i, "footage"],
  [/脚本|台词|口播稿|script/i, "script"],
  [/选题|角度|钩子|topic/i, "topic"],
];

function normalizeKind(kind: unknown, note: unknown): string | null {
  const hay = `${note ?? ""} ${kind ?? ""}`;
  for (const [re, target] of KIND_RULES) {
    if (re.test(hay)) return target;
  }
  const k = String(kind ?? "").toLowerCase();
  return (STAGE_ORDER as readonly string[]).includes(k) ? k : null;
}

// POST /api/project/[id]/chat { text } — the 对话剪辑 endpoint.
// DeepSeek parses her message into clip ops; we apply them to the script's
// clip list and reset the affected downstream stages so the worker
// regenerates voice/cards/cut/subs/delivery with the changes.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { text } = await req.json().catch(() => ({}));
  if (!String(text ?? "").trim()) return NextResponse.json({ error: "empty" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  await prisma.message.create({ data: { projectId: id, role: "user", text: String(text).trim() } });

  const scriptStage = project.stages.find((s) => s.kind === "script");
  const scriptArt = scriptStage?.artifacts ? JSON.parse(scriptStage.artifacts) : {};
  const clips: Clip[] = Array.isArray(scriptArt.clips) ? scriptArt.clips : [];
  const awaiting = project.stages.find((s) => s.status === "awaiting_review") ?? null;
  const assets = projectAssets(id);

  // 她问"右边这是什么"时,agent 必须答得出——把当前画面真实状态喂给它
  const footageStage = project.stages.find((s) => s.kind === "footage");
  const footageArt = footageStage?.artifacts ? JSON.parse(footageStage.artifacts) : {};
  const cardsCtx = Array.isArray(footageArt.cards)
    ? footageArt.cards.map((c: { name: string; text?: string; type?: string; theme?: string; asset?: string }, i: number) =>
        `图${i + 1}(${c.name}):${c.asset ? `素材「${c.asset}」` : `${c.type ?? "?"}卡/${c.theme ?? "?"}底`} — 台词"${(c.text ?? "").slice(0, 24)}"`,
      ).join("\n")
    : "";

  const stateCtx = [
    awaiting ? `右边正在审:${stageLabel(awaiting.kind)}` : "右边没有待审的东西",
    cardsCtx ? `素材阶段每拍实际用的画面:\n${cardsCtx}` : "",
  ].filter(Boolean).join("\n");

  let parsed;
  try {
    parsed = await parseChat(
      String(text).trim(),
      clips,
      project,
      awaiting ? { kind: awaiting.kind, label: stageLabel(awaiting.kind) } : null,
      assets,
      stateCtx,
    );
  } catch (e) {
    const reply = `解析失败(${e instanceof Error ? e.message : "LLM 错误"}),你的消息我记下了,稍后再试。`;
    await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
    return NextResponse.json({ ok: true, reply });
  }

  // ── review intent while a stage is at the gate: her words ARE the verdict ──
  const reviewOp = parsed.ops.find((o): o is Extract<ChatOp, { action: "review" }> => o.action === "review");
  if (reviewOp && awaiting) {
    const ok = await resolveStage(
      awaiting.id,
      reviewOp.decision,
      reviewOp.decision === "reject" ? reviewOp.note || String(text).trim() : undefined,
    );
    if (ok) {
      const reply =
        reviewOp.decision === "approve"
          ? `「${stageLabel(awaiting.kind)}」过了,agent 接着做下一阶段。`
          : `「${stageLabel(awaiting.kind)}」打回了,原因记上了,agent 重做中。`;
      await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
      return NextResponse.json({ ok: true, reply });
    }
  }

  // ── clip-level edits ──
  const assetNames = new Set(assets.map((a) => a.name));
  const clipOps = parsed.ops.filter((o) =>
    o.action === "assign_asset" ? assetNames.has(o.asset) : o.action !== "reply" && o.action !== "redo_stage" && o.action !== "review",
  );
  const redoOps = parsed.ops.filter((o): o is Extract<ChatOp, { action: "redo_stage" }> => o.action === "redo_stage");
  const notes: string[] = [];

  // ── clip-level edits ──
  if (clipOps.length && clips.length) {
    const { clips: next, voiceDirty, footageDirty } = applyOps(clips, clipOps);
    await prisma.stage.update({
      where: { id: scriptStage!.id },
      data: {
        artifacts: JSON.stringify({
          ...scriptArt,
          clips: next,
          script: next.map((c) => c.text).join("\n"),
        }),
      },
    });

    const resetFrom = footageDirty ? "footage" : voiceDirty ? "voice" : null;
    if (resetFrom) {
      const fromOrder = STAGE_ORDER.indexOf(resetFrom as (typeof STAGE_ORDER)[number]);
      // 连 working 中的阶段也翻回 pending:submit 的竞态守卫会作废它按旧输入产出的结果
    for (const s of project.stages) {
        if (s.order >= fromOrder) {
          // Keep old artifacts: the previous cut stays watchable while the new
          // one renders, and footage reuses unchanged card designs from them.
          await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
        }
      }
      await prisma.project.update({ where: { id }, data: { status: "producing" } });
      notes.push(footageDirty ? "画面/配音/剪辑/字幕都会重出" : "配音/剪辑/字幕会重出");
    }
  }

  // ── whole-stage redos (cover, caption, voice style…) — reuse the reject machinery ──
  for (const op of redoOps) {
    const kind = normalizeKind(op.kind, op.note);
    if (!kind) continue; // can't tell what she means → skip, reply already covers it
    const stage = project.stages.find((s) => s.kind === kind);
    if (!stage) continue;
    const comments = stage.comments ? JSON.parse(stage.comments) : [];
    comments.push({ ts: Date.now(), text: op.note || String(text).trim(), decision: "reject" });
    await prisma.stage.update({
      where: { id: stage.id },
      data: { status: "changes_requested", comments: JSON.stringify(comments) },
    });
    // downstream of a redo goes stale → re-run after it (keep artifacts: old
    // version stays watchable while the new one renders)
    for (const s of project.stages) {
      if (s.order > stage.order) {
        await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
      }
    }
    await prisma.project.update({ where: { id }, data: { status: "producing" } });
  }

  const reply = parsed.reply + (notes.length ? `(${notes.join(";")})` : "");
  await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
  return NextResponse.json({ ok: true, reply });
}
