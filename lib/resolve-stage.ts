import { prisma } from "@/lib/db";
import { runDelivery } from "@/lib/deliver";

// Shared review-gate resolution — used by the resolve API and by chat ops
// (她说"过了"= approve,"没激情"= reject+note).
// Returns false if the stage isn't at the gate.
export async function resolveStage(
  stageId: string,
  decision: "approve" | "comment" | "reject",
  text?: string,
): Promise<boolean> {
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage || stage.status !== "awaiting_review") return false;

  const comments = stage.comments ? JSON.parse(stage.comments) : [];
  if (text) comments.push({ ts: Date.now(), text, decision });

  let status = stage.status;
  if (decision === "approve") status = "approved";
  else if (decision === "reject") status = "changes_requested";

  await prisma.stage.update({
    where: { id: stageId },
    data: { status, comments: JSON.stringify(comments) },
  });

  if (decision === "approve" && stage.kind === "deliver") {
    await runDelivery(stage.projectId);
  }

  const stages = await prisma.stage.findMany({ where: { projectId: stage.projectId } });
  const allApproved = stages.every((s) => s.status === "approved");
  const proj = await prisma.project.findUnique({ where: { id: stage.projectId } });
  if (proj && proj.status !== "delivered") {
    await prisma.project.update({
      where: { id: stage.projectId },
      data: { status: allApproved ? "approved" : decision === "reject" ? "producing" : "reviewing" },
    });
  }
  return true;
}
