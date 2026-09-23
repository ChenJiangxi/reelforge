// ffmpeg/ffprobe helpers.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfsSync, mkdirSync } from "node:fs";
const run = promisify(execFile);

const FF = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
const FP = process.env.FFPROBE_BIN || "/opt/homebrew/bin/ffprobe";

// execFile 的原始报错是整条命令行 + 全部 stderr(一条剪辑命令几 KB),塞进失败说明里
// 她一个字都看不懂。只留 stderr 最后两行;盘满单独认出来,标 disk,worker 会说清楚是磁盘。
// 常见报错先翻成人话,原文留在后面给排查用
const HINTS = [
  [/moov atom not found|Invalid data found|could not find codec parameters/i, "素材文件坏了或没传完整"],
  [/No such file or directory/i, "文件不存在"],
  [/Permission denied/i, "没有读写权限"],
  [/Cannot allocate memory|Killed/i, "内存不够,被系统杀掉了"],
];
function concise(e, tool) {
  const stderr = String(e?.stderr ?? "").trim();
  const tail = stderr
    .split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" / ")
    .replace(/\/(?:[^/\s:]+\/)+([^/\s:]+)/g, "$1") // 绝对路径只留文件名
    .replace(/\s*@ 0x[0-9a-f]+/g, "");
  const raw = tail || String(e?.message ?? e);
  const disk = /No space left on device|ENOSPC/i.test(stderr + String(e?.message ?? ""));
  const hint = HINTS.find(([re]) => re.test(raw))?.[1];
  const err = new Error(disk ? "磁盘写满了" : `${hint ? `${hint}(` : ""}${tool}:${raw.slice(0, 200)}${hint ? ")" : ""}`);
  if (disk) err.disk = true;
  return err;
}

export async function ffmpeg(args) {
  try {
    await run(FF, ["-nostdin", "-y", "-v", "error", ...args], { maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw concise(e, "ffmpeg");
  }
}

export async function ffprobeDur(file) {
  try {
    const { stdout } = await run(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return parseFloat(stdout.trim());
  } catch (e) {
    throw concise(e, "ffprobe");
  }
}

export async function ffprobeInfo(file) {
  try {
    const { stdout } = await run(FP, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
    return JSON.parse(stdout);
  } catch (e) {
    throw concise(e, "ffprobe");
  }
}

// Run ffmpeg and KEEP its stderr+stdout (blackdetect/freezedetect report there).
export async function ffmpegOut(args) {
  try {
    const { stdout, stderr } = await run(FF, ["-nostdin", "-hide_banner", ...args], { maxBuffer: 32 * 1024 * 1024 });
    return `${stdout}\n${stderr}`;
  } catch (e) {
    throw concise(e, "ffmpeg");
  }
}

// ── 磁盘水位 ──────────────────────────────────────────────────────────
// 渲染前就要知道盘够不够,而不是渲到一半 ENOSPC 挂掉、留下半截文件。
export function freeGB(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const st = statfsSync(dir);
    return (Number(st.bavail) * Number(st.bsize)) / 1073741824;
  } catch {
    return Infinity; // 量不了就不拦
  }
}

export function ensureDisk(dir, minGB, where) {
  const free = freeGB(dir);
  if (free < minGB) {
    const err = new Error(`${where}时渲染机磁盘只剩 ${free.toFixed(1)} GB(至少要 ${minGB} GB)`);
    err.disk = true;
    throw err;
  }
  return free;
}
