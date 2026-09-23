import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

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

export type AssetEntry = { name: string; url: string; kind: "video" | "image" | "page"; size: number; global?: boolean; file?: string };

const VIDEO_RE = /\.(mp4|mov|webm|m4v)$/i;
const MEDIA_RE = /\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif)$/i;

// 素材库(项目自己的,或者 _global 共享库)—— 以前页面、poll、聊天、两个素材接口各扫一遍盘,
// 五份几乎一样的代码。URL 带 ?v=<修改时间>:同名重新上传后 URL 会变,worker 按 URL 缓存,
// 不然会一直用第一次下载的那份旧文件(和 2026-09-16 字幕吃旧粗剪是同一种毛病)。
export function listAssets(ownerId: string, opts: { global?: boolean } = {}): AssetEntry[] {
  if (!isSafeId(ownerId)) return [];
  const dir = path.join(MEDIA_DIR, ownerId, "assets");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: AssetEntry[] = [];
  for (const f of files) {
    // 产品页(worker/capture.mjs 录的):<短名>.page.json 是素材本身,切片图和整页原图不单独列出
    if (/\.page\.json$/.test(f)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { name?: string };
        out.push({
          name: doc.name || f.replace(/\.page\.json$/, ""),
          url: `/api/media/${ownerId}/assets/${encodeURIComponent(f)}?v=${Math.round(st.mtimeMs)}`,
          kind: "page",
          size: st.size,
          file: f,
          ...(opts.global ? { global: true } : {}),
        });
      } catch {
        /* 坏文件跳过 */
      }
      continue;
    }
    if (/\.page-(\d+|full)\.png$/.test(f)) continue;
    if (!MEDIA_RE.test(f)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, f));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      name: f,
      url: `/api/media/${ownerId}/assets/${encodeURIComponent(f)}?v=${Math.round(st.mtimeMs)}`,
      kind: VIDEO_RE.test(f) ? "video" : "image",
      size: st.size,
      ...(opts.global ? { global: true } : {}),
    });
  }
  return out;
}

/** 这个项目能用的全部素材:自己的在前,共享库在后 */
export function projectAssets(projectId: string): AssetEntry[] {
  return [...listAssets(projectId), ...listAssets("_global", { global: true })];
}

// 上传素材(项目的或共享库的)。名字保留中文(LLM 靠名字挑素材),只去掉路径和危险字符;
// 只收视频和图片;盘不够就整批拒收并说清楚 —— 以前两个接口各写一份,失败了前端也不知道。
export async function saveUploads(form: FormData, ownerId: string): Promise<{ saved: string[]; skipped: string[]; error?: string }> {
  if (!isSafeId(ownerId)) return { saved: [], skipped: [], error: "bad id" };
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return { saved: [], skipped: [], error: "没有收到文件" };
  const dir = path.join(MEDIA_DIR, ownerId, "assets");
  fs.mkdirSync(dir, { recursive: true });
  const total = files.reduce((n, f) => n + f.size, 0);
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < total + 300 * 1024 * 1024) {
      return { saved: [], skipped: [], error: `服务器磁盘只剩 ${(free / 1073741824).toFixed(1)} GB,放不下这批文件(${(total / 1048576).toFixed(0)} MB)` };
    }
  } catch {
    /* statfs 不可用就不拦 */
  }
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const name = path.basename(file.name).replace(/\.\./g, "").replace(/[\\/:*?"<>|\0]/g, "_").trim() || `asset-${Date.now()}`;
    if (!MEDIA_RE.test(name)) {
      skipped.push(file.name);
      continue;
    }
    await pipeline(Readable.fromWeb(file.stream() as never), fs.createWriteStream(path.join(dir, name)));
    saved.push(name);
  }
  return { saved, skipped, error: saved.length ? undefined : "只收视频和图片(mp4/mov/webm/png/jpg/webp/gif)" };
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
