import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { STAGE_ORDER, VOICE_OPTIONS, ASPECT_OPTIONS, platformForAspect } from "@/lib/stages";

// Create a new video project + its full stage pipeline (选题 → … → 交付).
// All stages start pending; the worker claims each one once earlier stages
// are approved (选题 first — it turns the raw idea into an angle + hook).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic ?? "").trim();
  const aspect = ASPECT_OPTIONS.some((o) => o.value === body.aspect) ? body.aspect : "9:16";
  const platform = platformForAspect(aspect);
  const title = String(body.title ?? "").trim() || (topic ? topic.slice(0, 28) : "未命名项目");
  const voice = VOICE_OPTIONS.some((o) => o.value === body.voice) ? body.voice : "clone-zh";
  const material = String(body.material ?? "").trim().slice(0, 8000);
  const bgm = body.bgm === "yes" ? "yes" : "none";
  const duration = Math.min(180, Math.max(30, parseInt(body.duration, 10) || 75));
  if (!topic) return NextResponse.json({ error: "请先填一句主题" }, { status: 400 });

  const project = await prisma.project.create({
    data: { title, topic, platform, voice, bgm, aspect, duration, status: "producing" },
  });

  for (let order = 0; order < STAGE_ORDER.length; order++) {
    await prisma.stage.create({
      data: {
        projectId: project.id,
        kind: STAGE_ORDER[order],
        order,
        status: "pending",
        // 参考材料存在选题阶段的产物里:选题提示词读 item.artifacts.material,再由选题往下传给脚本。
        // 2026-09-13 加了输入框,这里却一直没存 —— 她贴的资料十天里全被丢掉了。
        artifacts: order === 0 ? JSON.stringify({ note: `原始想法:${topic}`, ...(material ? { material } : {}) }) : null,
      },
    });
  }

  return NextResponse.json({ ok: true, id: project.id });
}
