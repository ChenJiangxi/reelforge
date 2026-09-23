import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { MEDIA_DIR, isSafeId } from "@/lib/media";

// 调用记录:每个项目一个 JSONL,worker 批量传上来,服务端自己的 LLM 调用(聊天解析、改稿切拍)直接写。
// 不进数据库 —— 纯追加、按项目读,文件就够,也不用动 schema。
// 存在 MEDIA_DIR 的上一级(生产是 /opt/reelforge/calls),不经过 /api/media,只能用下面的接口按项目读。
export const CALLS_DIR = process.env.CALLS_DIR || path.join(path.dirname(MEDIA_DIR), "calls");
const MAX_FILE = 20 * 1024 * 1024; // 超过就把旧的挪成 .1,只留最近一份

export type CallRecord = {
  id: string;
  ts: number;
  projectId: string;
  stageId?: string;
  stage?: string;
  beat?: string;
  step?: string;
  kind: string; // llm | vision | tts
  model?: string;
  repair?: number;
  status?: string; // ok | invalid | error
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  request?: { messages?: { role: string; content: string }[]; text?: string; params?: unknown };
  response?: string;
  usage?: unknown;
  finish?: string;
  validation?: string[];
  annotate?: boolean;
};

function fileOf(projectId: string) {
  return path.join(CALLS_DIR, `${projectId}.jsonl`);
}

export function appendCalls(records: CallRecord[]) {
  const byProject = new Map<string, CallRecord[]>();
  for (const r of records) {
    if (!r || typeof r !== "object" || !isSafeId(String(r.projectId ?? ""))) continue;
    const list = byProject.get(r.projectId) ?? [];
    list.push(r);
    byProject.set(r.projectId, list);
  }
  fs.mkdirSync(CALLS_DIR, { recursive: true });
  for (const [pid, list] of byProject) {
    const f = fileOf(pid);
    try {
      if (fs.statSync(f).size > MAX_FILE) fs.renameSync(f, `${f}.1`);
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(f, list.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return byProject.size;
}

export function readCalls(projectId: string): CallRecord[] {
  if (!isSafeId(projectId)) return [];
  const out = new Map<string, CallRecord>();
  for (const f of [`${fileOf(projectId)}.1`, fileOf(projectId)]) {
    let raw = "";
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CallRecord;
        // 注释记录:解析/校验结论晚于记录本身才出来时补的一行
        if (r.annotate) {
          const base = out.get(r.id);
          if (base) Object.assign(base, { status: r.status, validation: r.validation });
          continue;
        }
        out.set(r.id, r);
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return [...out.values()].sort((a, b) => b.ts - a.ts);
}

/** 服务端自己发的 LLM 请求也记一条(聊天解析、亲手改稿后的切拍) */
export function recordServerCall(rec: Omit<CallRecord, "id" | "ts"> & { ts?: number }) {
  try {
    appendCalls([{ id: randomUUID(), ts: Date.now(), ...rec } as CallRecord]);
  } catch {
    /* 记录是辅助,写不进去不能影响正事 */
  }
}
