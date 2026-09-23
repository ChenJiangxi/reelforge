import { NextRequest, NextResponse } from "next/server";
import { applyOverrides, applyProjectSettings } from "@/lib/overrides";
import type { Overrides } from "@/lib/stages";

// POST /api/project/[id]/override { clip, set?: Overrides, unset?: (keyof Overrides)[] | "all" }
//                              或 { project: { sfx: "on"|"off" } }
// 网页上决定清单里的开关:改一拍的剪辑参数,或者撤销。确定性操作,不过 LLM。
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  // 整条片的设置(音效开关):{ project: { sfx: "on"|"off" } }
  if (body.project && typeof body.project === "object") {
    const r = await applyProjectSettings(id, body.project);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, summary: r.summary });
  }
  const clip = String(body.clip ?? "");
  if (!clip) return NextResponse.json({ error: "clip required" }, { status: 400 });
  const unset = body.unset === "all" ? "all" : Array.isArray(body.unset) ? (body.unset as (keyof Overrides)[]) : undefined;
  const r = await applyOverrides(id, [{ clip, set: body.set as Overrides | undefined, unset }]);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true, summary: r.summary });
}
