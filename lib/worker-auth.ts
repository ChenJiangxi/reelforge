import { NextRequest, NextResponse } from "next/server";

// The macmini render worker authenticates with a shared bearer token (WORKER_TOKEN
// env on the server, same value in the worker's env). This is separate from the
// browser access gate (ACCESS_CODE cookie) so middleware can exempt /api/worker/*.
export function checkWorkerAuth(req: NextRequest): NextResponse | null {
  const token = process.env.WORKER_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "WORKER_TOKEN not configured" }, { status: 500 });
  }
  const got = req.headers.get("authorization") ?? "";
  if (got !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
