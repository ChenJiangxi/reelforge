import { NextResponse } from "next/server";
import { SCENE_ON } from "@/lib/shots";

// GET /api/features → 这台服务器开了哪些要花钱的功能(网页据此显示/隐藏按钮)
export async function GET() {
  return NextResponse.json({ sceneImages: SCENE_ON });
}
