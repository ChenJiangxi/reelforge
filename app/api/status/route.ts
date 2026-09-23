import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { workerStatus } from "@/lib/worker-state";
import type { Comment } from "@/lib/stages";

// GET /api/status?project=<id> —— 页面每几秒拉一次:渲染机在不在、这个项目手上在做什么、
// 有几个活正等着渲染机来拿(和 poll 同一个判断:前面阶段都通过了、不是失败停放的)
export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  const w = workerStatus();
  const cands = await prisma.stage.findMany({
    where: { status: { in: ["pending", "changes_requested", "working"] } },
    include: { project: { include: { stages: { select: { order: true, status: true } } } } },
  });
  let claimable = 0;
  for (const s of cands) {
    if (s.status === "working") { claimable++; continue; }
    if (!s.project.stages.filter((x) => x.order < s.order).every((x) => x.status === "approved")) continue;
    const ev: Comment[] = s.comments ? JSON.parse(s.comments) : [];
    const last = ev.filter((c) => c.decision === "reject" || c.decision === "failed").at(-1);
    if (s.status === "changes_requested" && last?.decision === "failed") continue;
    claimable++;
  }
  return NextResponse.json({
    worker: { online: w.online, agoSec: w.agoSec, lastSeen: w.lastSeen, diskGB: w.diskGB },
    claimable,
    jobs: project ? w.jobs.filter((j) => j.projectId === project) : w.jobs,
  });
}
