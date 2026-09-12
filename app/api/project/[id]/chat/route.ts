import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseChat, applyOps, type Clip, type ChatOp } from "@/lib/chat-ops";
import { STAGE_ORDER } from "@/lib/stages";

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

  let parsed;
  try {
    parsed = await parseChat(String(text).trim(), clips, project);
  } catch (e) {
    const reply = `解析失败(${e instanceof Error ? e.message : "LLM 错误"}),你的消息我记下了,稍后再试。`;
    await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
    return NextResponse.json({ ok: true, reply });
  }

  const clipOps = parsed.ops.filter((o) => o.action !== "reply" && o.action !== "redo_stage");
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
      for (const s of project.stages) {
        if (s.order >= fromOrder && s.status !== "working") {
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
    const stage = project.stages.find((s) => s.kind === op.kind);
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
      if (s.order > stage.order && s.status !== "working") {
        await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
      }
    }
    await prisma.project.update({ where: { id }, data: { status: "producing" } });
  }

  const reply = parsed.reply + (notes.length ? `(${notes.join(";")})` : "");
  await prisma.message.create({ data: { projectId: id, role: "agent", text: reply } });
  return NextResponse.json({ ok: true, reply });
}
