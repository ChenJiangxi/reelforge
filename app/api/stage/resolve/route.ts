import { NextRequest, NextResponse } from "next/server";
import { resolveStage } from "@/lib/resolve-stage";

export async function POST(req: NextRequest) {
  const { stageId, decision, text, skip } = await req.json();
  const ok = await resolveStage(String(stageId ?? ""), decision, text, Array.isArray(skip) ? skip.map(String) : undefined);
  if (!ok) {
    return NextResponse.json(
      { error: "stage is not awaiting_review (or not found)" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
