import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runDelivery } from "@/lib/deliver";

export async function POST(req: NextRequest) {
  const { stageId, decision, text } = await req.json();
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Review actions only make sense at the review gate — never approve a stage
  // that is still working or has failed back to changes_requested.
  if (stage.status !== "awaiting_review") {
    return NextResponse.json(
      { error: `stage is ${stage.status}, not awaiting_review` },
      { status: 409 },
    );
  }

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
    }
    // Otherwise the next stage is already `pending`; the worker claims it
    // once all earlier stages are approved (see /api/worker/poll).
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
