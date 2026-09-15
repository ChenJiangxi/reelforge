import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

// 教案(选题/脚本/审稿/画面)存在服务器文件里:worker 每 60s 拉取,她在
// /playbooks 页在线编辑。GET 对 worker 开放(教案不是秘密);PUT 过 cookie 闸门。
const NAMES = new Set(["topic", "script", "critique", "visual", "voice"]);
const DIR = () => {
  const d = process.env.PLAYBOOKS_DIR || path.join(process.cwd(), "data", "playbooks");
  mkdirSync(d, { recursive: true });
  return d;
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!NAMES.has(name)) return NextResponse.json({ error: "unknown playbook" }, { status: 404 });
  const p = path.join(DIR(), `${name}.md`);
  return NextResponse.json({ name, text: existsSync(p) ? readFileSync(p, "utf8") : "" });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!NAMES.has(name)) return NextResponse.json({ error: "unknown playbook" }, { status: 404 });
  const { text } = await req.json().catch(() => ({}));
  if (typeof text !== "string" || !text.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  writeFileSync(path.join(DIR(), `${name}.md`), text);
  return NextResponse.json({ ok: true });
}
