import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";

// POST /api/worker/claim { stageId } — flip a claimable stage to working.
// Refuses if someone else already took it, so double-claims are harmless.
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;

  const { stageId } = await req.json().catch(() => ({}));
  if (!stageId) return NextResponse.json({ error: "stageId required" }, { status: 400 });

  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (stage.status !== "pending" && stage.status !== "changes_requested") {
    return NextResponse.json({ error: `not claimable (status=${stage.status})` }, { status: 409 });
  }

  await prisma.stage.update({ where: { id: stageId }, data: { status: "working" } });
  return NextResponse.json({ ok: true });
}
