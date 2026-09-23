// 画面镜头(scene)的配图:OpenRouter 上的 Gemini 图像模型,一张约 7 秒、0.039 美元。
// 按「风格 + 画幅 + 画面描述」缓存在 WORK_ROOT/.images/ —— 同一张图不重复花钱;
// 素材阶段和剪辑阶段都调它(她在网页上改过的镜头剪辑阶段才第一次见到)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpeg } from "./ffmpeg.mjs";
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
  const req = imageRequest(prompt, style, aspect, IMAGE_MODEL, ref ? dataUrl(ref.path) : null);
  const rec = startCall("image", IMAGE_MODEL, { messages: [{ role: "user", content: typeof req.messages[0].content === "string" ? req.messages[0].content : req.messages[0].content[0].text + "\n[参考图:主角定妆照]" }], params: { aspect, ref: ref?.key } });
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(120_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`生图接口 ${r.status}:${JSON.stringify(j).slice(0, 160)}`);
      const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) throw new Error(`生图没返回图片(可能被安全策略拦了):${String(j.choices?.[0]?.message?.content ?? "").slice(0, 80)}`);
      const png = join(dir, `${key}.png`);
      writeFileSync(png, Buffer.from(url.split(",")[1], "base64"));
      await ffmpeg(["-i", png, "-q:v", "3", jpg]);
      endCall(rec, { status: "ok", response: `图 ${key}`, usage: j.usage });
      return { path: jpg, key, cached: false, cost: j.usage?.cost };
    } catch (e) {
      lastErr = e;
    }
  }
  endCall(rec, { status: "error", error: String(lastErr?.message ?? lastErr).slice(0, 300) });
  throw lastErr;
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
