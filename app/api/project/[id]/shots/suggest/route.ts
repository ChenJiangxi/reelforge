import { NextRequest, NextResponse } from "next/server";
import { suggestShots } from "@/lib/shots";

// POST /api/project/[id]/shots/suggest { beat, index, hint?, tpl? } → { options: Shot[] }
// 「换一个」:3 个候选,不落库。带 tpl = 她在下拉里换了模板,让 AI 按这个模板把内容填上
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await suggestShots(id, String(body.beat ?? ""), Number(body.index ?? 0), body.hint ? String(body.hint).slice(0, 200) : undefined, body.tpl ? String(body.tpl) : undefined);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ options: r.options });
}
