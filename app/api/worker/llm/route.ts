import { NextRequest, NextResponse } from "next/server";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { claimJobs, finishJob, waitForJobs } from "@/lib/llm-relay";
import { claimTasks } from "@/lib/worker-tasks";
import { workerSeen } from "@/lib/worker-state";

// 渲染机长轮询领 LLM 活(最多挂 25 秒),用本机 Claude 跑完再 POST 回来。见 lib/llm-relay.ts
export async function GET(req: NextRequest) {
  const bad = checkWorkerAuth(req);
  if (bad) return bad;
  workerSeen();
  let jobs = claimJobs();
  let tasks = claimTasks();
  if (!jobs.length && !tasks.length) {
    await waitForJobs(25_000, req.signal);
    // 连接已经断了(渲染机重启/网络断):别领活,领了也送不到
    if (req.signal.aborted) return new NextResponse(null, { status: 204 });
    jobs = claimJobs();
    tasks = claimTasks();
  }
  return NextResponse.json({ jobs, tasks: tasks.map(({ id, type, projectId, url, name }) => ({ id, type, projectId, url, name })) });
}

export async function POST(req: NextRequest) {
  const bad = checkWorkerAuth(req);
  if (bad) return bad;
  const body = await req.json().catch(() => ({}));
  const ok = finishJob(String(body.id ?? ""), { ok: !!body.ok, text: body.text, error: body.error });
  return NextResponse.json({ ok });
}
