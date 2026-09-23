import { NextRequest, NextResponse } from "next/server";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { claimJobs, finishJob, waitForJobs } from "@/lib/llm-relay";
import { workerSeen } from "@/lib/worker-state";

// 渲染机长轮询领 LLM 活(最多挂 25 秒),用本机 Claude 跑完再 POST 回来。见 lib/llm-relay.ts
export async function GET(req: NextRequest) {
  const bad = checkWorkerAuth(req);
  if (bad) return bad;
  workerSeen();
  let jobs = claimJobs();
  if (!jobs.length) {
    await waitForJobs(25_000);
    jobs = claimJobs();
  }
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const bad = checkWorkerAuth(req);
  if (bad) return bad;
  const body = await req.json().catch(() => ({}));
  const ok = finishJob(String(body.id ?? ""), { ok: !!body.ok, text: body.text, error: body.error });
  return NextResponse.json({ ok });
}
