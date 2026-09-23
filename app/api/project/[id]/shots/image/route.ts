import { NextRequest, NextResponse } from "next/server";
import { generateScene } from "@/lib/shots";

// POST /api/project/[id]/shots/image { prompt, who? } → { src, srcKey }  分镜板上「重新生成画面」:按这条片的风格生一张图,不落库
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await generateScene(id, String(body.prompt ?? ""), body.who ? String(body.who) : undefined);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json({ src: r.src, srcKey: r.srcKey });
}
