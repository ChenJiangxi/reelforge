import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkWorkerAuth } from "@/lib/worker-auth";
import type { Comment } from "@/lib/stages";

// GET /api/worker/poll — stages the worker may claim:
// status pending (previous stages all approved) or changes_requested (with the
// latest review comment attached, so the worker addresses the note, not redoes).
export async function GET(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;

  const candidates = await prisma.stage.findMany({
    where: { status: { in: ["pending", "changes_requested"] } },
    include: { project: { include: { stages: { orderBy: { order: "asc" } } } } },
    orderBy: { updatedAt: "asc" },
  });

  const items = [];
  for (const s of candidates) {
    const earlier = s.project.stages.filter((x) => x.order < s.order);
    if (!earlier.every((x) => x.status === "approved")) continue;
    const comments: Comment[] = s.comments ? JSON.parse(s.comments) : [];
    const last = comments.filter((c) => c.decision === "reject").at(-1);
    // Carry forward approved upstream artifacts the worker needs as input
    // (topic angle for script, script for voice/footage, etc.).
    const upstream: Record<string, unknown> = {};
    for (const x of s.project.stages) {
      if (x.order < s.order && x.status === "approved" && x.artifacts) {
        upstream[x.kind] = JSON.parse(x.artifacts);
      }
    }
    items.push({
      stageId: s.id,
      kind: s.kind,
      status: s.status,
      projectId: s.projectId,
      title: s.project.title,
      topic: s.project.topic,
      platform: s.project.platform,
      voice: s.project.voice,
      bgm: s.project.bgm,
      aspect: s.project.aspect,
      duration: s.project.duration,
      artifacts: s.artifacts ? JSON.parse(s.artifacts) : {},
      comment: s.status === "changes_requested" ? last?.text ?? null : null,
      upstream,
    });
  }
  return NextResponse.json(items);
}
