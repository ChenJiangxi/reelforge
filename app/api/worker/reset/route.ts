import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";

// POST /api/worker/reset — worker startup recovery: stages stuck in `working`
// (worker crashed/rebooted mid-stage) go back to pending so they get re-claimed.
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;

  const staleMs = 2 * 60 * 1000; // anything still "working" at startup is stale by definition
  const cutoff = new Date(Date.now() - staleMs);
  const r = await prisma.stage.updateMany({
    where: { status: "working", updatedAt: { lt: cutoff } },
    data: { status: "pending" },
  });
  return NextResponse.json({ ok: true, reset: r.count });
}
