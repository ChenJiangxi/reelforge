import path from "path";
import fs from "fs";

// All generated media (cards, voice, video, covers, packages) lives under MEDIA_DIR —
// never under public/ (Next standalone only serves public/ files present at process
// boot; anything the worker ships later 404s). Media is streamed by route handlers.
export const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.join(process.cwd(), "data", "media");

export function projectMediaDir(projectId: string): string {
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
