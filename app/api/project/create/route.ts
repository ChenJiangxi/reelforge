import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { STAGE_ORDER } from "@/lib/stages";

// Create a new video project + its full stage pipeline (选题 → … → 交付).
// The 选题 stage carries the user's idea; the rest start pending, waiting for the
// worker (macmini) to pick them up.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic ?? "").trim();
  const platform = String(body.platform ?? "douyin").trim() || "douyin";
  const title = String(body.title ?? "").trim() || (topic ? topic.slice(0, 28) : "未命名项目");
  if (!topic) return NextResponse.json({ error: "请先填一句主题" }, { status: 400 });

  const project = await prisma.project.create({
    data: { title, topic, platform, status: "producing" },
  });

  for (let order = 0; order < STAGE_ORDER.length; order++) {
    await prisma.stage.create({
      data: {
        projectId: project.id,
        kind: STAGE_ORDER[order],
        order,
        status: order === 0 ? "working" : "pending",
        artifacts: order === 0 ? JSON.stringify({ note: `选题方向：${topic}` }) : null,
      },
    });
  }

  return NextResponse.json({ ok: true, id: project.id });
}
