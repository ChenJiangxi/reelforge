import { NextRequest, NextResponse } from "next/server";
import { applyShots } from "@/lib/shots";

// POST /api/project/[id]/shots { beat, shots: Shot[] }   改这一拍的镜头(只重跑剪辑)
//                              { beat, reset: true }       恢复成自动排的
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const beat = String(body.beat ?? "");
  if (!beat) return NextResponse.json({ error: "beat required" }, { status: 400 });
  const r = await applyShots(id, beat, body.reset ? null : body.shots);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, summary: r.summary });
}
