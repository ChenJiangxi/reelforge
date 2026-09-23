// 画面镜头的生图提示词:风格统一加在描述后面(LLM 只写"画什么",一条片风格才一致)。
// 渲染机(worker/images.mjs)和网页服务端(lib/shots.ts)共用,两边生出来的是同一张图、同一个缓存键。
import { createHash } from "node:crypto";

export const IMAGE_MODEL_DEFAULT = "google/gemini-2.5-flash-image";

export const IMAGE_STYLES = {
  photo: "写实电影感摄影,浅景深,胶片质感,自然光影,情绪真实。人物是中国人、东亚面孔,现代日常穿着。",
  ink: "国风水墨插画,淡墨山水,朱红与金色点缀,大面积留白,东方意境。人物为中国古风形象。",
  glow: "梦幻光影 3D 渲染,深蓝色宇宙背景,金色细碎粒子,电影感体积光,庄严神秘。",
};
export const IMAGE_STYLE_LABELS = { photo: "写实电影感", ink: "国风水墨", glow: "梦幻光影" };

const COMMON = "画面里绝对不要出现任何文字、字母、数字、招牌、水印、Logo。主体放在画面中上部,下方三分之一偏暗,留给字幕。";
const ASPECT = { "9:16": "9:16", "3:4": "3:4", "16:9": "16:9" };

/** 缓存键:风格、画幅、描述、参考的主角(定妆照的键)任何一个变了就是另一张图 */
export function sceneKey(prompt, style, aspect, refKey = "") {
  return createHash("sha1").update(`${style}|${aspect}|${refKey}|${String(prompt ?? "").trim()}`).digest("hex").slice(0, 12);
}

/** 主角定妆照的描述(全片有主角的画面都拿它当参考图,保证是同一个人) */
export function castPrompt(desc) {
  return `角色定妆照:${String(desc ?? "").trim()}。正面半身像,看向镜头,表情自然,简洁干净的浅灰背景,柔和自然光,清晰的五官。`;
}

/**
 * 发给 OpenRouter 的请求体。ref = 主角定妆照的 data URL:画面里的人要和它是同一个人
 * @param {string} prompt
 * @param {string} style
 * @param {string} aspect
 * @param {string} [model]
 * @param {string | null} [ref]
 */
export function imageRequest(prompt, style, aspect, model = IMAGE_MODEL_DEFAULT, ref = null) {
  const text = `${ASPECT[aspect] === "16:9" ? "横版" : "竖版"}画面:${String(prompt).trim()}\n风格:${IMAGE_STYLES[style] ?? IMAGE_STYLES.photo}\n${COMMON}`;
  const content = ref
    ? [
        { type: "text", text: `参考图里的人就是这个画面的主角:保持同一张脸、同样的发型和穿着,但姿势、表情、场景按下面的描述来,不要照搬参考图的构图和背景。\n${text}` },
        { type: "image_url", image_url: { url: ref } },
      ]
    : text;
  return { model: model || IMAGE_MODEL_DEFAULT, modalities: ["image", "text"], image_config: { aspect_ratio: ASPECT[aspect] ?? "9:16" }, messages: [{ role: "user", content }] };
}
