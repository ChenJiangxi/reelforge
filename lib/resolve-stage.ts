import { prisma } from "@/lib/db";
import { runDelivery } from "@/lib/deliver";
import { requeue } from "@/lib/rerun";
import { stageLabel } from "@/lib/stages";

// Shared review-gate resolution — used by the resolve API and by chat ops
// (她说"过了"= approve,"没激情"= reject+note).
// 打回走 requeue():和其它所有重跑入口同一套依赖计算,skip = 她在表单里取消的下游。
// Returns false if the stage isn't at the gate.
export async function resolveStage(
  stageId: string,
  decision: "approve" | "comment" | "reject",
  text?: string,
  skip?: string[],
): Promise<boolean> {
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage || stage.status !== "awaiting_review") return false;

  if (decision === "reject") {
    await requeue(stage.projectId, {
      redo: [stage.kind],
      note: text,
      skip,
      reason: `你打回了「${stageLabel(stage.kind)}」`,
    });
    return true;
  }

  const comments = stage.comments ? JSON.parse(stage.comments) : [];
  if (text) comments.push({ ts: Date.now(), text, decision });
  await prisma.stage.update({
    where: { id: stageId },
    data: { status: decision === "approve" ? "approved" : stage.status, comments: JSON.stringify(comments) },
  });

  const stages = await prisma.stage.findMany({ where: { projectId: stage.projectId } });
  const allApproved = stages.every((s) => s.status === "approved");
  // 全部通过就(重新)打包:交付不依赖成片,所以只改了剪辑时交付不会重跑 ——
  // 包里的视频要在这里换成最新的,而不是停在上一次交付那天。
  if (decision === "approve" && allApproved) {
    try {
      await runDelivery(stage.projectId);
      if (stage.kind !== "deliver") {
        await prisma.message.create({
          data: { projectId: stage.projectId, role: "agent", text: "全部阶段都过了,下载包已经换成最新的成片。" },
        });
      }
      return true;
    } catch (e) {
      await prisma.message.create({
        data: { projectId: stage.projectId, role: "agent", text: `打包失败:${e instanceof Error ? e.message : String(e)}` },
      });
    }
  }
  const proj = await prisma.project.findUnique({ where: { id: stage.projectId } });
  if (proj && proj.status !== "delivered") {
    await prisma.project.update({
      where: { id: stage.projectId },
      data: { status: allApproved ? "approved" : "reviewing" },
    });
  }
  return true;
}
