import { randomUUID } from "node:crypto";
import { wakeWaiters } from "@/lib/llm-relay";

// 交给渲染机做的活(目前只有「录产品页」):网站下单 → 渲染机长轮询 /api/worker/llm 时一起领走 →
// 做完 POST /api/worker/task 交回。放在内存里,服务器重启会丢(页面上会显示失败,重新点一次)。
export type Task = {
  id: string;
  type: "capture";
  projectId: string;
  url: string;
  name: string;
  createdAt: number;
  claimedAt?: number;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  result?: { asset?: string };
};

type State = { tasks: Map<string, Task> };
const g = globalThis as unknown as { __rfTasks?: State };
const S: State = (g.__rfTasks ??= { tasks: new Map() });

export function enqueueCapture(projectId: string, url: string, name: string): Task {
  const t: Task = { id: randomUUID(), type: "capture", projectId, url, name, createdAt: Date.now(), status: "queued" };
  S.tasks.set(t.id, t);
  wakeRelay();
  return t;
}

/** 渲染机来领:排着的,或者领走 10 分钟还没交回的(渲染机中途重启)重新发 */
export function claimTasks(max = 1) {
  const now = Date.now();
  const out: Task[] = [];
  for (const t of S.tasks.values()) {
    if (out.length >= max) break;
    if (t.status === "queued" || (t.status === "running" && now - (t.claimedAt ?? 0) > 600_000)) {
      t.status = "running";
      t.claimedAt = now;
      out.push(t);
    }
  }
  return out;
}

export function finishTask(id: string, r: { ok: boolean; error?: string; result?: Task["result"] }) {
  const t = S.tasks.get(id);
  if (!t) return false;
  t.status = r.ok ? "done" : "error";
  t.error = r.error;
  t.result = r.result;
  return true;
}

export function taskOf(id: string) {
  return S.tasks.get(id) ?? null;
}

// 有新活时叫醒正挂着的长轮询(和 LLM 队列共用一个等待)
function wakeRelay() {
  wakeWaiters();
}
