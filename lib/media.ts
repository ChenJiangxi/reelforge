import path from "path";
import fs from "fs";

// All generated media (cards, voice, video, covers, packages) lives under MEDIA_DIR —
// never under public/ (Next standalone only serves public/ files present at process
// boot; anything the worker ships later 404s). Media is streamed by route handlers.
export const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.join(process.cwd(), "data", "media");

// 项目 id 只能是 cuid 或 _global —— 以前直接拼路径,/api/media/..%2Fdata/reelforge.db
// 不登录就能把数据库下载走(2026-09-23 发现,日志里没有被利用过)。
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** MEDIA_DIR/<projectId>/<segments…>,任何一段不干净、或者解析后跑出项目目录,返回 null */
export function mediaPath(projectId: string, segments: string[]): string | null {
  if (!isSafeId(projectId)) return null;
  if (!segments.length || segments.some((s) => !s || s === "." || s === ".." || /[\\/\0]/.test(s))) return null;
  const root = path.resolve(MEDIA_DIR, projectId);
  const full = path.resolve(root, ...segments);
  return full.startsWith(root + path.sep) ? full : null;
}

export function projectMediaDir(projectId: string): string {
  if (!isSafeId(projectId)) throw new Error(`bad project id: ${projectId}`);
  const dir = path.join(MEDIA_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Keep user/worker-supplied file names inside the project dir.
export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]/g, "_");
  return base || "file";
}

export function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ass": return "text/plain; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}
