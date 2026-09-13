import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { stageLabel } from "@/lib/stages";

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

  // 竞态守卫:worker 跑到一半时她又在聊天里改了东西(阶段已被重置成 pending/
  // changes_requested)——这次提交的产物是按旧输入做的,作废,重跑。
  if (stage.status !== "working") {
    await prisma.stage.update({ where: { id: stageId }, data: { status: "pending" } });
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

  await prisma.stage.update({
    where: { id: stageId },
    data: { status, artifacts: JSON.stringify(merged) },
  });

  if (status === "awaiting_review") {
    await prisma.project.update({
      where: { id: stage.projectId },
      data: { status: "reviewing" },
    });
    // chat = event stream: tell her the new version is ready for the gate
    await prisma.message.create({
      data: {
        projectId: stage.projectId,
        role: "agent",
        text: `「${stageLabel(stage.kind)}」新版好了,在右边审 →`,
      },
    });
  } else {
    // worker gave up: surface it in chat instead of parking silently
    const why = String((artifacts as { note?: string } | undefined)?.note ?? "").replace(/^FAILED:\s*/, "");
    await prisma.message.create({
      data: {
        projectId: stage.projectId,
        role: "agent",
        text: `「${stageLabel(stage.kind)}」没做成:${why || "未知原因"}。要我重试就说一声,或者手动把它重置。`,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
