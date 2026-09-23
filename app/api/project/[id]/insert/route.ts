import { NextRequest, NextResponse } from "next/server";
import { applyInsert, type InsertOp } from "@/lib/inserts";

// POST /api/project/[id]/insert
//   { op:"add", t, asset, mode?, dur? }            在成片第 t 秒插入(盖在原画面上)
//   { op:"add", after:"c03", asset, kind:"gap", dur? }  在 c03 后面插一段纯画面(拉长停顿)
//   { op:"update", id, t?, dur?, mode? } / { op:"remove", id }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as InsertOp;
  const r = await applyInsert(id, body);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, summary: r.summary });
}
