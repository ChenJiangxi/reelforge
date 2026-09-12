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
