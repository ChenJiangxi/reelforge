import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { stageLabel, type Failure } from "@/lib/stages";
import { pushEvent, requeue } from "@/lib/rerun";

// POST /api/worker/submit { stageId, status, artifacts? }
// status = awaiting_review: work done, artifacts merged over the existing ones
//   (earlier fields the worker didn't touch are preserved).
// status = changes_requested: worker gave up; the note field should say why.
// Anything else is rejected — a stage must never be left in `working`.
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const { stageId, status, artifacts } = body;
  if (!stageId || !["awaiting_review", "changes_requested"].includes(status)) {
    return NextResponse.json(
      { error: "stageId + status(awaiting_review|changes_requested) required" },
      { status: 400 },
    );
  }

  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 竞态守卫:worker 跑到一半时她又改了东西(阶段已被 requeue 成 pending/changes_requested)——
  // 这次提交的产物是按旧输入做的,作废。状态保持 requeue 设好的样子:以前这里一律改回
  // pending,打回时写的批注就跟着丢了(poll 只在 changes_requested 时带批注)。
  if (stage.status !== "working") {
    if (status !== "awaiting_review") return NextResponse.json({ ok: true, stale: true }); // 旧那次失败了,无所谓
    await prisma.message.create({
      data: {
        projectId: stage.projectId,
        role: "agent",
        text: `「${stageLabel(stage.kind)}」刚跑完的那版是按你改之前的需求做的,作废了。正在按最新要求重出。`,
      },
    });
    return NextResponse.json({ ok: true, stale: true });
  }

  let merged = stage.artifacts ? JSON.parse(stage.artifacts) : {};
  if (artifacts && typeof artifacts === "object") merged = { ...merged, ...artifacts };
  if (status === "awaiting_review") delete merged.failure;

  await prisma.stage.update({
    where: { id: stageId },
    data: { status, artifacts: JSON.stringify(merged) },
  });

  if (status === "awaiting_review") {
    await prisma.project.update({
      where: { id: stage.projectId },
      data: { status: "reviewing" },
    });
    const warns = Array.isArray(merged.decisions) ? merged.decisions.filter((d: { warn?: boolean }) => d.warn).length : 0;
    // chat = event stream: tell her the new version is ready for the gate
    await prisma.message.create({
      data: {
        projectId: stage.projectId,
        role: "agent",
        text: `「${stageLabel(stage.kind)}」新版好了,在右边审 →${warns ? `(这一步有 ${warns} 个决定标了黄,建议先看一眼)` : ""}`,
      },
    });
    if (stage.kind === "script") await guardBeatCount(stage.projectId, merged);
  } else {
    // worker gave up: surface it in chat instead of parking silently — 说清楚卡在哪一拍、哪一步
    const f = (artifacts as { failure?: Failure } | undefined)?.failure;
    const why = f?.message || String((artifacts as { note?: string } | undefined)?.note ?? "").replace(/^FAILED:\s*/, "") || "未知原因";
    await pushEvent(stageId, { ts: Date.now(), text: why, decision: "failed" });
    const where = f ? [f.beat ? `第 ${Number(f.beat.slice(1))} 拍(${f.beat})` : "", f.step ?? ""].filter(Boolean).join(" · ") : "";
    const next =
      f?.kind === "disk"
        ? "清出空间后 worker 会自动接着做,也可以点右边的「重试」。"
        : "点右边的「重试」再来一次;要换个做法就写一句批注。";
    await prisma.message.create({
      data: {
        projectId: stage.projectId,
        role: "agent",
        text: `「${stageLabel(stage.kind)}」没做成${where ? `,卡在 ${where}` : ""}:${why}。${next}`,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

// 拍数变了是硬依赖:每拍一张的画面不可能沿用。她重做脚本时哪怕取消了「素材」,
// 新脚本拍数一变也必须把素材拉回来重出 —— 否则剪辑阶段画面和配音对不上,当场失败。
async function guardBeatCount(projectId: string, scriptArt: { clips?: unknown[] }) {
  const footage = await prisma.stage.findFirst({ where: { projectId, kind: "footage" } });
  if (!footage || footage.status === "pending" || !footage.artifacts) return;
  const cards = (JSON.parse(footage.artifacts).cards ?? []) as unknown[];
  const n = Array.isArray(scriptArt.clips) ? scriptArt.clips.length : 0;
  if (!cards.length || !n || cards.length === n) return;
  await requeue(projectId, {
    redo: ["footage"],
    beatCountChanged: true,
    reason: `新脚本是 ${n} 拍,画面还是 ${cards.length} 拍,每拍一张的画面没法沿用(这一步没法取消)`,
  });
}
