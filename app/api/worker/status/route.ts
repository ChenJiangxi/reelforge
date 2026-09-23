import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";

// GET /api/worker/status?ids=a,b → { a: "working", b: "pending" }
// worker 每轮查一次手上阶段的状态:不是 working 了 = 她改了需求、阶段被重新排队,马上停。
export async function GET(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const ids = (req.nextUrl.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 20);
  if (!ids.length) return NextResponse.json({});
  const rows = await prisma.stage.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  return NextResponse.json(Object.fromEntries(rows.map((r) => [r.id, r.status])));
}
