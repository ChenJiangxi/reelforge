import fs from "fs";
import path from "path";
import { MEDIA_DIR } from "@/lib/media";
import type { Artifacts, Comment, Version } from "@/lib/stages";

// 每一步的版本历史:每出一版记一条(媒体链接 + 为什么重出 + 剪辑当时用的参数),最多留 6 版。
// 媒体文件名带版本号(worker 上传时加的),所以旧版的链接不会被新版覆盖;挤出去的旧版文件顺手删掉。
export type { Version } from "@/lib/stages";

const KEEP = 6;
const MEDIA_KEYS = ["video", "audio", "wave", "cover"] as const;

function entryOf(art: Artifacts & Record<string, unknown>, v: number, ts: number, reason: string, kind: string, script?: Artifacts & Record<string, unknown>): Version {
  const ds = Array.isArray(art.decisions) ? art.decisions : [];
  const e: Version = { v, ts, reason, warn: ds.filter((d) => d.warn).length, decisions: ds.length };
  for (const k of MEDIA_KEYS) if (typeof art[k] === "string") e[k] = art[k] as string;
  if (kind === "deliver" && art.caption) e.caption = art.caption;
  if (kind === "script") {
    e.script = typeof art.script === "string" ? art.script : undefined;
    e.clips = Array.isArray(art.clips) ? art.clips : undefined;
  }
  if (kind === "edit" && script) {
    const perClip: Version["settings"] = { perClip: {}, editSettings: script.editSettings };
    for (const c of (Array.isArray(script.clips) ? script.clips : []) as { name: string; overrides?: unknown; inserts?: unknown }[]) {
      if (c.overrides || c.inserts) perClip.perClip[c.name] = { overrides: c.overrides, inserts: c.inserts };
    }
    e.settings = perClip;
  }
  return e;
}

/** 这一版为什么出:最近一条打回批注或"因为谁排队" */
export function reasonOf(comments: Comment[]): string {
  const last = [...comments].reverse().find((c) => c.decision === "reject" || c.decision === "queued");
  if (!last) return "第一版";
  return last.decision === "reject" ? `你打回:${last.text}` : last.text.replace(/^因为/, "");
}

/**
 * 提交新一版时调用:把新版记进历史(旧产物还没进历史的话先把它补成一条),裁到 6 版,删掉被挤出去的媒体文件。
 * 返回新的 history。
 */
export function pushVersion(opts: {
  projectId: string;
  kind: string;
  prev: Artifacts & Record<string, unknown>;
  next: Artifacts & Record<string, unknown>;
  prevTs: number;
  comments: Comment[];
  script?: Artifacts & Record<string, unknown>;
}): Version[] {
  const { projectId, kind, prev, next, prevTs, comments, script } = opts;
  let hist: Version[] = Array.isArray(prev.history) ? (prev.history as Version[]) : [];
  const hasMedia = (a: Record<string, unknown>) => MEDIA_KEYS.some((k) => typeof a[k] === "string") || (kind === "script" && typeof a.script === "string");
  if (!hist.length && hasMedia(prev)) hist = [entryOf(prev, 1, prevTs, "之前的版本", kind)];
  const v = (hist.at(-1)?.v ?? 0) + 1;
  hist = [...hist, entryOf(next, v, Date.now(), reasonOf(comments), kind, script)];
  const dropped = hist.slice(0, Math.max(0, hist.length - KEEP));
  hist = hist.slice(-KEEP);
  // 被挤出去的旧版文件:只删带版本号的(xxx-<时间戳>.mp4 这种),而且现在/剩下的版本都没在用
  const inUse = new Set(hist.flatMap((h) => MEDIA_KEYS.map((k) => h[k]).filter(Boolean) as string[]));
  for (const k of MEDIA_KEYS) if (typeof next[k] === "string") inUse.add(next[k] as string);
  for (const d of dropped) {
    for (const k of MEDIA_KEYS) {
      const url = d[k];
      if (!url || inUse.has(url)) continue;
      const m = url.match(new RegExp(`^/api/media/${projectId}/([\\w.-]+-[a-z0-9]{6,}\\.(?:mp4|mp3|png))`));
      if (!m) continue;
      try {
        fs.unlinkSync(path.join(MEDIA_DIR, projectId, m[1]));
      } catch {
        /* 已经没了 */
      }
    }
  }
  return hist;
}
