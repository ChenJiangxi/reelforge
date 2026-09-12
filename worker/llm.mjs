// OpenRouter chat completions — the pipeline brain. Default deepseek-v3.2
// (~$0.27/$0.40 per M token, a 60-90s video costs well under ¥0.1 of LLM).
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v3.2";

export async function chat(messages, { model = MODEL, temperature = 0.7, maxTokens = 4000 } = {}) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not in env");
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 120000); // a hung socket ate 20min once
      let r;
      try {
        r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(killer);
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`openrouter ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      const text = j.choices?.[0]?.message?.content;
      if (!text) throw new Error(`openrouter empty response: ${JSON.stringify(j).slice(0, 300)}`);
      return text;
    } catch (e) {
      lastErr = e;
      const net = e.name === "AbortError" || e.message === "fetch failed";
      console.log(`[llm] attempt ${attempt} failed: ${e.message?.slice(0, 120)}`);
      if (!net || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

// Ask for a JSON object back; tolerate code fences / surrounding prose.
export async function chatJSON(messages, opts = {}) {
  const text = await chat(messages, opts);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in LLM reply: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

// Vision pass for rendered cards — gemini-2.5-flash-lite ($0.10/M in) actually
// LOOKS at the PNG and returns { ok, issues[] } against the visual playbook.
const VISION_MODEL = process.env.VISION_MODEL || "google/gemini-2.5-flash-lite";

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
