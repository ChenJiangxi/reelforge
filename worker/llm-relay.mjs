// 网站服务器上的 LLM 请求(聊天框解析、「换一个」、改稿重新分拍)由这里接:
// 长轮询 GET /api/worker/llm 领活 → 本机 Claude 跑 → POST 回结果。见 lib/llm-relay.ts
// 同一个长轮询也带回别的活(tasks,目前只有「录产品页」),做完 POST /api/worker/task。见 lib/worker-tasks.ts
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeRun, toClaudeInput } from "./claude.mjs";
import { upload } from "./board.mjs";

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

// 录产品页:一次只录一个(每次开一个 Chromium,别叠着开)
let chain = Promise.resolve();
function runTask(t) {
  chain = chain.then(() => doTask(t)).catch(() => {});
}

async function doTask(t) {
  const t0 = Date.now();
  let body;
  const dir = mkdtempSync(join(tmpdir(), "rf-capture-"));
  try {
    if (t.type !== "capture") throw new Error(`不认识的任务类型 ${t.type}`);
    const { capturePage } = await import("./capture.mjs");
    // 文件名只用英文数字(服务器存文件会把中文换成下划线);素材库里显示的是 name
    const base = "page-" + createHash("sha1").update(`${t.url}|${t.name}`).digest("hex").slice(0, 8);
    const r = await capturePage({ url: t.url, name: base, outDir: dir });
    r.layout.name = t.name;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(r.jsonPath, JSON.stringify(r.layout));
    // 先传切片,最后传 json:json 一到素材库就会列出来,那时切片必须已经在
    for (const tl of r.tiles) await upload(t.projectId, tl.path, tl.file, 1, null, { into: "assets" });
    await upload(t.projectId, r.jsonPath, `${base}.page.json`, 1, null, { into: "assets" });
    body = { id: t.id, ok: true, result: { asset: `${base}.page.json` } };
    console.log(`[task] 录产品页「${t.name}」ok ${((Date.now() - t0) / 1000).toFixed(0)}s:${r.tiles.length} 张切片,${r.layout.leaves.length} 段文字,分区 ${r.layout.sections.map((x) => x.title).join("、")}`);
  } catch (e) {
    body = { id: t.id, ok: false, error: String(e.message).slice(0, 300) };
    console.log(`[task] 录产品页「${t.name}」失败:${body.error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await fetch(`${BOARD}/api/worker/task`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch((e) => console.log(`[task] 回传失败:${e.message}`));
}

export function startLlmRelay() {
  (async () => {
    for (;;) {
      try {
        const r = await fetch(`${BOARD}/api/worker/llm`, { headers: H, signal: AbortSignal.timeout(40_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { jobs = [], tasks = [] } = await r.json();
        for (const j of jobs) answer(j); // 不等:多个请求并发跑(claude.mjs 里有并发上限)
        for (const t of tasks) runTask(t);
      } catch (e) {
        console.log(`[llm-relay] 领活失败:${String(e.message).slice(0, 100)},5 秒后重试`);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
  })();
}
