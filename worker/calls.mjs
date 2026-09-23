// 调用记录(学 MuseDock 的 apiCallRecorder):每一次 LLM / 看图 / 配音请求都留一条 ——
// 属于哪个项目、哪一步、哪一拍、第几次、是不是补正、耗时、返回了什么、校验过没过。
// 以后她问"它为什么写成这样",直接翻原始返回,不用猜。
//
// 上下文用 AsyncLocalStorage 挂在每个阶段的执行上(index.mjs 的 runItem),
// 所以 llm.mjs / stages.mjs 里的调用不用层层传参。记录先攒在内存里,
// 每 15 秒和每个阶段结束时批量传到服务器(/api/worker/calls)。
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const ctx = new AsyncLocalStorage();
const buffer = [];

const MAX_TEXT = 20_000; // 单条消息
const MAX_REQUEST = 60_000; // 一次请求所有消息合计
const MAX_RESPONSE = 64_000;

// last 放在一个共享的小盒子里:补正(asRepair)会开一层新上下文,但"最近一次调用"必须是同一个,
// 不然补正那次的校验结论会记到原来那次头上
export function withCallContext(item, fn) {
  return ctx.run({ item, repair: 0, lastRef: { rec: null } }, fn);
}

/** 补正(带着具体问题让模型重做)的那次调用,记录上标 repair=1 */
export function asRepair(fn) {
  const store = ctx.getStore();
  if (!store) return fn();
  return ctx.run({ ...store, repair: 1 }, fn);
}

function cut(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…(截断,原长 ${t.length} 字)` : t;
}

// 请求里的图片是 base64,几百 KB 一张,换成一句说明
function summarizeMessages(messages) {
  let budget = MAX_REQUEST;
  return (messages || []).map((m) => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content
        .map((p) => (p.type === "image_url" ? `[图片 ${Math.round(String(p.image_url?.url ?? "").length * 0.75 / 1024)} KB]` : String(p.text ?? "")))
        .join("\n");
    }
    const text = cut(content, Math.min(MAX_TEXT, Math.max(200, budget)));
    budget -= text.length;
    return { role: m.role, content: text };
  });
}

export function startCall(kind, model, { messages, params, text } = {}) {
  const store = ctx.getStore();
  const item = store?.item;
  const rec = {
    id: randomUUID(),
    ts: Date.now(),
    projectId: item?.projectId,
    stageId: item?.stageId,
    stage: item?.kind,
    beat: item?.progress?.beat,
    step: item?.progress?.step,
    kind, // llm | vision | tts
    model,
    repair: store?.repair ?? 0,
    request: messages ? { messages: summarizeMessages(messages), params } : { text: cut(text, 4000), params },
  };
  if (store) store.lastRef.rec = rec;
  return rec;
}

export function endCall(rec, fields) {
  Object.assign(rec, fields, { durationMs: Date.now() - rec.ts });
  if (typeof rec.response === "string") rec.response = cut(rec.response, MAX_RESPONSE);
  if (rec.projectId) buffer.push(rec);
}

/** 解析/校验之后给最近一次调用补结论:invalid + 具体问题。已经传走了就补一条注释记录 */
export function annotateLast(status, validation = []) {
  const rec = ctx.getStore()?.lastRef?.rec;
  if (!rec) return;
  const fields = { status, validation: validation.slice(0, 20).map((v) => cut(v, 300)) };
  if (buffer.includes(rec)) Object.assign(rec, fields);
  else if (rec.projectId) buffer.push({ id: rec.id, projectId: rec.projectId, annotate: true, ...fields });
}

let flushing = null;
export async function flushCalls(post) {
  if (flushing) return flushing;
  if (!buffer.length) return;
  const batch = buffer.splice(0, buffer.length);
  flushing = post(batch)
    .catch((e) => {
      // 传不上就放回去下次再传;攒太多就丢最老的(记录是辅助,不能拖垮 worker)
      buffer.unshift(...batch);
      if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000);
      console.log(`[calls] 调用记录没传上(${String(e.message).slice(0, 80)}),下次再传`);
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}
