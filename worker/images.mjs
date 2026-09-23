// 画面镜头(scene)的配图。生图服务目前没接(2026-09-24 她定不用 OpenRouter / Gemini / MiniMax),只用缓存里已有的图。
// 按「风格 + 画幅 + 画面描述」缓存在 WORK_ROOT/.images/ —— 同一张图不重复花钱;
// 素材阶段和剪辑阶段都调它(她在网页上改过的镜头剪辑阶段才第一次见到)。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startCall, endCall } from "./calls.mjs";
import { IMAGE_MODEL_DEFAULT, IMAGE_STYLES, sceneKey, imageRequest, castPrompt } from "../shots/image-style.mjs";

export const IMAGE_MODEL = process.env.IMAGE_MODEL || IMAGE_MODEL_DEFAULT;
export { sceneKey, IMAGE_STYLES, castPrompt };

/** 生成(或从缓存拿)一张图,返回本地 jpg 路径。ref = {path, key}:主角定妆照,画面里的人要和它一致 */
export async function sceneImage(prompt, { style = "photo", aspect = "9:16", workRoot, ref = null }) {
  const key = sceneKey(prompt, style, aspect, ref?.key ?? "");
  const dir = join(workRoot, ".images");
  mkdirSync(dir, { recursive: true });
  const jpg = join(dir, `${key}.jpg`);
  if (existsSync(jpg)) return { path: jpg, key, cached: true };
  // 2026-09-24 她定:不用 OpenRouter / Gemini / MiniMax 生图。生图服务没接之前,这里只认缓存里已有的图
  void imageRequest;
  void startCall;
  void endCall;
  throw new Error("生图服务没接(不用 OpenRouter / Gemini / MiniMax 生图);要画面镜头得先定一个她同意的来源");
}

/** 本地图 → data URL(Remotion 渲染时直接塞进参数,不用再起一个文件服务)。网页端存的是 png,按文件头认 */
export function dataUrl(path) {
  const buf = readFileSync(path);
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** 限并发地跑一组异步任务 */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

/** 主角定妆照(按描述和风格缓存) */
export async function castImage(desc, { style = "photo", aspect = "9:16", workRoot }) {
  return sceneImage(castPrompt(desc), { style, aspect: aspect === "16:9" ? "3:4" : aspect, workRoot });
}
