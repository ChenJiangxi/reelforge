// 网站服务器上的 LLM 请求(聊天框解析、「换一个」、改稿重新分拍)由这里接:
// 长轮询 GET /api/worker/llm 领活 → 本机 Claude 跑 → POST 回结果。见 lib/llm-relay.ts
import { claudeRun, toClaudeInput } from "./claude.mjs";

const BOARD = process.env.BOARD_URL;
const TOKEN = process.env.WORKER_TOKEN;
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function answer(job) {
  const t0 = Date.now();
  let body;
  try {
    const r = await claudeRun({ ...toClaudeInput(job.messages), model: job.tier === "deep" ? "opus" : "sonnet", timeoutMs: 170_000 });
    body = { id: job.id, ok: true, text: r.text };
  } catch (e) {
    body = { id: job.id, ok: false, error: String(e.message).slice(0, 300) };
  }
  console.log(`[llm-relay] ${job.tier} ${body.ok ? "ok" : "失败"} ${((Date.now() - t0) / 1000).toFixed(1)}s${body.ok ? "" : " " + body.error}`);
  await fetch(`${BOARD}/api/worker/llm`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch((e) => console.log(`[llm-relay] 回传失败:${e.message}`));
}

export function startLlmRelay() {
  (async () => {
    for (;;) {
      try {
        const r = await fetch(`${BOARD}/api/worker/llm`, { headers: H, signal: AbortSignal.timeout(40_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { jobs = [] } = await r.json();
        for (const j of jobs) answer(j); // 不等:多个请求并发跑(claude.mjs 里有并发上限)
      } catch (e) {
        console.log(`[llm-relay] 领活失败:${String(e.message).slice(0, 100)},5 秒后重试`);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
}
