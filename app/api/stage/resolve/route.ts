import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runDelivery } from "@/lib/deliver";

export async function POST(req: NextRequest) {
  const { stageId, decision, text } = await req.json();
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });

  const comments = stage.comments ? JSON.parse(stage.comments) : [];
  if (text) comments.push({ ts: Date.now(), text, decision });

  let status = stage.status;
  if (decision === "approve") status = "approved";
  else if (decision === "reject") status = "changes_requested";
  // decision === "comment": keep awaiting_review

  await prisma.stage.update({
    where: { id: stageId },
    data: { status, comments: JSON.stringify(comments) },
  });

  if (decision === "approve") {
    if (stage.kind === "deliver") {
      await runDelivery(stage.projectId);
    } else {
      // advance the next stage to its review gate
      const next = await prisma.stage.findFirst({
        where: { projectId: stage.projectId, order: stage.order + 1 },
      });
      if (next && next.status === "pending") {
        await prisma.stage.update({ where: { id: next.id }, data: { status: "awaiting_review" } });
      }
    }
  }

  const stages = await prisma.stage.findMany({ where: { projectId: stage.projectId } });
  const allApproved = stages.every((s) => s.status === "approved");
  const proj = await prisma.project.findUnique({ where: { id: stage.projectId } });
  if (proj && proj.status !== "delivered") {
    await prisma.project.update({
      where: { id: stage.projectId },
      data: { status: allApproved ? "approved" : "reviewing" },
    });
  }

  return NextResponse.json({ ok: true });
}
