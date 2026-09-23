// 管线的大脑:本机 Claude(worker/claude.mjs)。2026-09-24 起不再走 OpenRouter / DeepSeek。
// 调用方传的 model 如果是老的 OpenRouter 名字(deepseek/…、google/…),一律换成默认的 Claude 模型。
import { startCall, endCall, annotateLast, asRepair } from "./calls.mjs";
import { claudeRun, toClaudeInput, ClaudeLimitError } from "./claude.mjs";

const MODEL = process.env.CLAUDE_MODEL || "opus";
const alias = (m) => (/^(opus|sonnet|haiku)$/.test(String(m)) ? m : MODEL);

export async function chat(messages, { model = MODEL, temperature = 0.7, maxTokens = 4000 } = {}) {
  const m = alias(model);
  const input = toClaudeInput(messages);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const rec = startCall(input.images.length ? "vision" : "llm", `claude-${m}`, { messages, params: { temperature, max_tokens: maxTokens, attempt } });
    try {
      const r = await claudeRun({ ...input, model: m });
      endCall(rec, { status: r.text ? "ok" : "error", response: r.text, usage: r.usage });
      if (!r.text) throw new Error("本机 Claude 返回了空回答");
      return r.text;
    } catch (e) {
      if (rec.durationMs == null) endCall(rec, { status: "error", error: String(e.message).slice(0, 300) });
      lastErr = e;
      console.log(`[llm] attempt ${attempt} failed: ${String(e.message).slice(0, 120)}`);
      if (e instanceof ClaudeLimitError) break; // 额度用完了,重试也没用
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

// Ask for a JSON object back; tolerate code fences / surrounding prose.
// 实见的污染:数字被包进字母/竖线(`"speed": II0.95II`)、尾逗号、中文引号当 JSON 的引号用
// (`"visual": “你有贵人”四个字`)。先按规则修;修不好就让它重答一次 —— 整个阶段因为一个脏字符
// FAILED 停在那儿,比多调一次贵得多。
function repairJSON(raw) {
  return raw
    .replace(/:\s*[A-Za-z|]{1,3}(-?\d+(?:\.\d+)?)[A-Za-z|]{1,3}\s*(?=[,}\]])/g, ": $1")
    .replace(/,\s*(?=[}\]])/g, "")
    // 中文引号只在"当分隔符用"的位置换成英文引号;字符串内容里的中文引号是合法字符,不能动
    .replace(/([{,[]\s*)[\u201c\u201d]/g, '$1"') // 键的开头 / 数组元素开头
    .replace(/[\u201c\u201d](\s*:)/g, '"$1') // 键的结尾
    .replace(/(:\s*)[\u201c\u201d]/g, '$1"') // 值的开头
    .replace(/[\u201c\u201d](\s*[,}\]])/g, '"$1'); // 值的结尾
}

function parseLoose(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in LLM reply: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    try {
      const out = JSON.parse(repairJSON(m[0]));
      console.log("[llm] JSON 有脏字符,已修复后解析");
      return out;
    } catch {
      throw new Error(`bad JSON from LLM: ${e.message}. head=${m[0].slice(0, 160)}`);
    }
  }
}

// validate(obj) → 问题清单(每条写清哪一项、哪里不对、允许什么)。有问题就续在同一段对话里
// "只改这些,其余保持不变"让它补正一次(学 MuseDock structuredDraft 的格式补正);
// 补正后的问题必须**更少**才采用,否则留原稿 —— 交给调用方自己的兜底处理。
// 调用方拿得到 obj.__issues(最后还剩的问题),写进决定清单。
export async function chatJSON(messages, opts = {}, validate = null) {
  const text = await chat(messages, opts);
  let obj;
  try {
    obj = parseLoose(text);
  } catch (e) {
    annotateLast("invalid", [String(e.message)]);
    console.log(`[llm] ${String(e.message).slice(0, 100)} → 让它重答一次`);
    const again = await asRepair(() =>
      chat(
        [
          ...messages,
          { role: "assistant", content: text.slice(0, 6000) },
          { role: "user", content: "上面这段不是合法 JSON(常见原因:用了中文引号“”当 JSON 的引号、字符串里有没转义的英文双引号、尾逗号)。内容不变,只返回修正后的合法 JSON,不要任何解释。" },
        ],
        { ...opts, temperature: 0.2 },
      ),
    );
    try {
      obj = parseLoose(again);
    } catch (e2) {
      annotateLast("invalid", [String(e2.message)]);
      throw e2;
    }
  }
  if (!validate) return obj;
  const issues = validate(obj) || [];
  if (!issues.length) return obj;
  annotateLast("invalid", issues);
  console.log(`[llm] 校验没过(${issues.length} 条):${issues.slice(0, 3).join(";")} → 带着问题补正一次`);
  let fixed = null;
  try {
    const raw = await asRepair(() =>
      chat(
        [
          ...messages,
          { role: "assistant", content: JSON.stringify(obj).slice(0, 40000) },
          { role: "user", content: `只修正下列问题,其余内容保持不变,返回完整 JSON(同样的结构),不要解释:\n${issues.map((x) => `- ${x}`).join("\n")}` },
        ],
        { ...opts, temperature: 0.2 },
      ),
    );
    try {
      fixed = parseLoose(raw);
    } catch (e) {
      // 补正稿本身 JSON 写坏了(长 JSON 常见):让它只修格式再交一次,别白白丢掉补正
      console.log(`[llm] 补正稿不是合法 JSON(${String(e.message).slice(0, 60)}) → 只修格式再要一次`);
      const again = await asRepair(() =>
        chat(
          [
            { role: "user", content: `下面这段本该是合法 JSON,但格式坏了(常见原因:中文引号“”当了 JSON 引号、字符串里有没转义的双引号、尾逗号、被截断)。内容不变,只返回修正后的完整合法 JSON,不要解释:\n${raw.slice(0, 40000)}` },
          ],
          { ...opts, temperature: 0 },
        ),
      );
      fixed = parseLoose(again);
    }
  } catch (e) {
    console.log(`[llm] 补正没成(${String(e.message).slice(0, 80)}),用原稿`);
  }
  if (fixed) {
    const left = validate(fixed) || [];
    annotateLast(left.length ? "invalid" : "ok", left);
    if (left.length < issues.length) {
      if (left.length) Object.defineProperty(fixed, "__issues", { value: left, enumerable: false });
      Object.defineProperty(fixed, "__repaired", { value: issues.length - left.length, enumerable: false });
      return fixed;
    }
  }
  Object.defineProperty(obj, "__issues", { value: issues, enumerable: false });
  return obj;
}

// 看图审稿:让本机 Claude 真的看一眼渲出来的图,按教案挑毛病,返回 { ok, issues[] }
// 看图也用本机 Claude(sonnet 快,够用)
const VISION_MODEL = process.env.VISION_MODEL || "sonnet";

export async function reviewImage(pngPath, checklist) {
  const { readFileSync } = await import("node:fs");
  const b64 = readFileSync(pngPath).toString("base64");
  const text = await chat(
    [
      {
        role: "user",
        content: [
          { type: "text", text: checklist + '\n\n返回 JSON:{"ok":true|false,"issues":["问题1","问题2"]}。没问题就 ok=true,issues=[]。只挑清单里的真毛病,别发挥。' },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    { model: VISION_MODEL, temperature: 0.1, maxTokens: 800 },
  );
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: true, issues: [] }; // 审稿失败不当阻塞
  try { return JSON.parse(m[0]); } catch { return { ok: true, issues: [] }; }
}

// Multi-frame overall review — for the final-cut QA (学 MuseDock visualQaService
// 的抽样帧总评,但我们一次调用看 3 帧,省 token)。
export async function reviewFrames(pngPaths, checklist) {
  const { readFileSync } = await import("node:fs");
  const content = [
    { type: "text", text: checklist + '\n\n返回 JSON:{"ok":true|false,"issues":["问题1"]}。' },
    ...pngPaths.map((p) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${readFileSync(p).toString("base64")}` },
    })),
  ];
  const text = await chat([{ role: "user", content }], { model: VISION_MODEL, temperature: 0.1, maxTokens: 1000 });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ok: true, issues: [] };
  try { return JSON.parse(m[0]); } catch { return { ok: true, issues: [] }; }
}
