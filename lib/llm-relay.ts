import { randomUUID } from "node:crypto";

// 网站服务器上要用 LLM 的地方(聊天框解析、「换一个」、改稿重新分拍)不再直接调 OpenRouter:
// 服务器跑不了本机 Claude,就把请求放进这个队列,渲染机(macmini)一直挂着长轮询
// GET /api/worker/llm,接到就用本机 Claude 跑,再 POST 回结果。
// 队列放在内存里:服务器是单进程,重启时正在等的请求会失败(前端会看到"没回话",重发即可)。

export type Msg = { role: "system" | "user" | "assistant"; content: string };
type Job = {
  id: string;
  messages: Msg[];
  tier: "fast" | "deep";
  createdAt: number;
  claimedAt?: number;
  done: (err: Error | null, text?: string) => void;
};

type State = { jobs: Map<string, Job>; waiters: Set<() => void> };
const g = globalThis as unknown as { __rfLLM?: State };
const S: State = (g.__rfLLM ??= { jobs: new Map(), waiters: new Set() });

function wake() {
  for (const w of [...S.waiters]) w();
}

/** 问一次本机 Claude;fast = sonnet(聊天框这类要快的),deep = opus */
export function askLLM(messages: Msg[], { tier = "fast", timeoutMs = 120_000 }: { tier?: "fast" | "deep"; timeoutMs?: number } = {}): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      S.jobs.delete(id);
      reject(new Error(`渲染机上的 Claude ${Math.round(timeoutMs / 1000)} 秒没回话(渲染机离线,或者 Claude 额度用完了)`));
    }, timeoutMs);
    S.jobs.set(id, {
      id,
      messages,
      tier,
      createdAt: Date.now(),
      done: (err, text) => {
        clearTimeout(timer);
        S.jobs.delete(id);
        if (err) reject(err);
        else resolve(text ?? "");
      },
    });
    wake();
  });
}

/** 渲染机来领活:没人领的,或者领走 3 分钟还没回的(渲染机中途重启)重新发 */
export function claimJobs(max = 3) {
  const now = Date.now();
  const out: { id: string; messages: Msg[]; tier: string }[] = [];
  for (const j of S.jobs.values()) {
    if (out.length >= max) break;
    if (j.claimedAt && now - j.claimedAt < 180_000) continue;
    j.claimedAt = now;
    out.push({ id: j.id, messages: j.messages, tier: j.tier });
  }
  return out;
}

export function waitForJobs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      S.waiters.delete(done);
      resolve();
    };
    const t = setTimeout(done, ms);
    S.waiters.add(done);
  });
}

export function finishJob(id: string, r: { ok: boolean; text?: string; error?: string }) {
  const j = S.jobs.get(id);
  if (!j) return false;
  j.done(r.ok ? null : new Error(r.error || "渲染机上的 Claude 出错了"), r.text);
  return true;
}

export function pendingCount() {
  return S.jobs.size;
}

/** 不抛异常的版本:{ok, text, error, durationMs} —— 调用方原来按 fetch 的 r.ok / text 写的,改动最小 */
export async function askLLMSafe(messages: Msg[], opts: { tier?: "fast" | "deep"; timeoutMs?: number } = {}) {
  const t0 = Date.now();
  try {
    const text = await askLLM(messages, opts);
    return { ok: !!text, text, error: text ? undefined : "空回答", durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, text: "", error: String((e as Error).message), durationMs: Date.now() - t0 };
  }
}
