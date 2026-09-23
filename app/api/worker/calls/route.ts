import { NextRequest, NextResponse } from "next/server";
import { checkWorkerAuth } from "@/lib/worker-auth";
import { appendCalls, type CallRecord } from "@/lib/calls";

// POST /api/worker/calls { records: CallRecord[] } — worker 批量传调用记录
export async function POST(req: NextRequest) {
  const denied = checkWorkerAuth(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const records = Array.isArray(body.records) ? (body.records as CallRecord[]).slice(0, 2000) : [];
  const projects = appendCalls(records);
  return NextResponse.json({ ok: true, projects });
}
