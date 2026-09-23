import { NextRequest, NextResponse } from "next/server";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { workerBeat } from "@/lib/worker-state";

// POST /api/worker/heartbeat { jobs, diskGB } —— worker 每 5 秒报一次
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  workerBeat(await req.json().catch(() => ({})));
  return NextResponse.json({ ok: true });
}
