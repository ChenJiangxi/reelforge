// ffmpeg/ffprobe helpers.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const FF = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
const FP = process.env.FFPROBE_BIN || "/opt/homebrew/bin/ffprobe";

export async function ffmpeg(args) {
  await run(FF, ["-nostdin", "-y", "-v", "error", ...args], { maxBuffer: 32 * 1024 * 1024 });
}

export async function ffprobeDur(file) {
  const { stdout } = await run(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(stdout.trim());
}

export async function ffprobeInfo(file) {
  const { stdout } = await run(FP, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  return JSON.parse(stdout);
}

// Run ffmpeg and KEEP its stderr+stdout (blackdetect/freezedetect report there).
export async function ffmpegOut(args) {
  const { stdout, stderr } = await run(FF, ["-nostdin", "-hide_banner", ...args], { maxBuffer: 32 * 1024 * 1024 });
  return `${stdout}\n${stderr}`;
}
