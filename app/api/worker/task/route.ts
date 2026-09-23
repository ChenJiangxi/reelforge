import { NextRequest, NextResponse } from "next/server";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { finishTask } from "@/lib/worker-tasks";

// 渲染机交回一件活的结果(录产品页等):{ id, ok, error?, result? }
export async function POST(req: NextRequest) {
  const bad = checkWorkerAuth(req);
  if (bad) return bad;
  const body = await req.json().catch(() => ({}));
  return NextResponse.json({ ok: finishTask(String(body.id ?? ""), { ok: !!body.ok, error: body.error, result: body.result }) });
}
