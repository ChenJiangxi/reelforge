import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requeue } from "@/lib/rerun";
import { stageLabel, type Artifacts } from "@/lib/stages";

// POST /api/stage/rerun { stageId, note?, skip?: string[] }
// 重做某一步 —— 审核门上的「打回」、已通过阶段的「重做这一步」、失败阶段的「重试」都走这里。
// 下游哪些跟着重出由 DEPS 算,锁死的她取消不了;skip 里是她取消了的可选下游。
// 失败后重试没写新批注时,沿用失败那次正在处理的批注(不然打回的要求在重试里丢了)。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const stageId = String(body.stageId ?? "");
  const stage = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!stage) return NextResponse.json({ error: "not found" }, { status: 404 });

  const art = (stage.artifacts ? JSON.parse(stage.artifacts) : {}) as Artifacts;
  const failed = stage.status === "changes_requested" && !!art.failure;
  let note = String(body.note ?? "").trim();
  if (!note && failed && art.failure?.note) note = art.failure.note;
  if (stage.status === "awaiting_review" && !note) {
    return NextResponse.json({ error: "打回要写一句原因,agent 照着改" }, { status: 400 });
  }
  const skip = Array.isArray(body.skip) ? body.skip.map(String) : [];
  const label = stageLabel(stage.kind);
  const reason =
    stage.status === "awaiting_review" ? `你打回了「${label}」` : failed ? `你让「${label}」重试` : `你让「${label}」重做`;
  const r = await requeue(stage.projectId, { redo: [stage.kind], note: note || undefined, skip, reason });
  return NextResponse.json({ ok: true, summary: r.summary, rows: r.rows });
}
