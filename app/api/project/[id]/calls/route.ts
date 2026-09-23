import { NextRequest, NextResponse } from "next/server";
import { readCalls } from "@/lib/calls";

// GET /api/project/[id]/calls?stage=edit        → 列表(不带请求/返回正文,最新在前,最多 300 条)
// GET /api/project/[id]/calls?id=<记录 id>       → 单条完整内容
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const one = req.nextUrl.searchParams.get("id");
  const stage = req.nextUrl.searchParams.get("stage");
  const all = readCalls(id);
  if (one) {
    const r = all.find((x) => x.id === one);
    return r ? NextResponse.json(r) : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const list = (stage ? all.filter((r) => r.stage === stage) : all).slice(0, 300).map(({ request, response, ...rest }) => ({
    ...rest,
    requestChars: request?.messages?.reduce((n, m) => n + m.content.length, 0) ?? request?.text?.length ?? 0,
    responseChars: response?.length ?? 0,
  }));
  return NextResponse.json(list);
}
