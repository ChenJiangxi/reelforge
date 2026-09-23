import { prisma } from "@/lib/db";
import { planRerun, stageLabel, type Comment, type PlanRow } from "@/lib/stages";

// 所有"让某些阶段重跑"的入口都走这一个函数:审核门打回、重做某一步、聊天改稿、
// 拖素材、换配音版本、剪辑参数覆盖、亲手改稿。以前是六处各写一遍级联,有的按依赖、
// 有的按 STAGE_ORDER 一刀切,打回本身还不级联 —— 同一件事六种结果。
// 依赖关系只有一张表(lib/stages.ts 的 DEPS),哪些锁死、哪些她取消了,一次算清,
// 再原样写进聊天,让她看得见这次到底动了哪些阶段。

export type RequeueInput = {
  /** 这次要重做的阶段本身 */
  redo?: string[];
  /** 产物已经被她直接改过的阶段(比如亲手改稿、选了另一版配音),只重跑它的下游 */
  changed?: string[];
  /** 她写的批注 —— 挂在 redo 阶段上,worker 照着改 */
  note?: string;
  /** 她在表单里取消了的 soft 下游 */
  skip?: string[];
  beatCountChanged?: boolean;
  /** 人话:为什么重跑("你打回了「素材」")—— 写进聊天和下游阶段的事件记录 */
  reason: string;
  /** 默认往聊天里发一条说明;调用方自己要发更具体的话时关掉 */
  announce?: boolean;
};

export type RequeueResult = { rows: PlanRow[]; summary: string };

function events(raw: string | null): Comment[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 阶段正在等着按她的批注重做(打回了、worker 还没接)—— 被别的改动连带时不能把批注冲掉
function hasPendingNote(status: string, ev: Comment[]): boolean {
  if (status !== "changes_requested") return false;
  const last = ev.filter((c) => c.decision === "reject" || c.decision === "failed").at(-1);
  return last?.decision === "reject";
}

export async function requeue(projectId: string, input: RequeueInput): Promise<RequeueResult> {
  const stages = await prisma.stage.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  const statuses = Object.fromEntries(stages.map((s) => [s.kind, s.status]));
  const rows = planRerun(
    { redo: input.redo, changed: input.changed, skip: input.skip, beatCountChanged: input.beatCountChanged },
    statuses,
  );
  const now = Date.now();
  const note = input.note?.trim();

  for (const row of rows) {
    const s = stages.find((x) => x.kind === row.kind);
    if (!s) continue;
    const ev = events(s.comments);
    if (row.state === "redo") {
      if (note) {
        ev.push({ ts: now, text: note, decision: "reject" });
        await prisma.stage.update({ where: { id: s.id }, data: { status: "changes_requested", comments: JSON.stringify(ev) } });
      } else if (!hasPendingNote(s.status, ev)) {
        ev.push({ ts: now, text: input.reason, decision: "queued" });
        await prisma.stage.update({ where: { id: s.id }, data: { status: "pending", comments: JSON.stringify(ev) } });
      }
    } else if (row.state === "hard" || row.state === "soft") {
      // 已经在排队的不重复记;working 的也翻回 pending —— submit 的守卫会作废按旧输入做完的那版
      if (s.status === "pending" || hasPendingNote(s.status, ev)) continue;
      ev.push({ ts: now, text: `因为${input.reason}`, decision: "queued" });
      await prisma.stage.update({ where: { id: s.id }, data: { status: "pending", comments: JSON.stringify(ev) } });
    }
  }

  if (rows.some((r) => r.state === "redo" || r.state === "hard" || r.state === "soft")) {
    await prisma.project.update({ where: { id: projectId }, data: { status: "producing" } });
  }

  const summary = summarize(input.reason, rows);
  if (input.announce !== false) {
    await prisma.message.create({ data: { projectId, role: "agent", text: summary } });
  }
  return { rows, summary };
}

// 一句话说清这次动了什么:重做谁、谁被连带(锁死的说明为什么)、谁她取消了、谁不受影响
export function summarize(reason: string, rows: PlanRow[]): string {
  const names = (st: PlanRow["state"][]) => rows.filter((r) => st.includes(r.state)).map((r) => stageLabel(r.kind));
  const redo = names(["redo"]);
  const follow = names(["hard", "soft"]);
  const skipped = names(["skipped"]);
  const firstTouched = rows.findIndex((r) => r.state !== "untouched");
  const untouched = rows.filter((r, i) => i > firstTouched && r.state === "untouched").map((r) => stageLabel(r.kind));
  const parts = [reason];
  if (redo.length) parts.push(`重做「${redo.join("」「")}」`);
  if (follow.length) parts.push(`跟着重出:${follow.join("、")}`);
  if (skipped.length) parts.push(`按你的意思不重出:${skipped.join("、")}`);
  if (untouched.length) parts.push(`不受影响:${untouched.join("、")}`);
  if (!redo.length && !follow.length) parts.push("没有阶段需要重跑");
  return parts.join("。") + "。";
}

// 事件记录追加一条(worker 失败、提交成功等),不改状态
export async function pushEvent(stageId: string, ev: Comment) {
  const s = await prisma.stage.findUnique({ where: { id: stageId } });
  if (!s) return;
  const list = events(s.comments);
  list.push(ev);
  await prisma.stage.update({ where: { id: stageId }, data: { comments: JSON.stringify(list) } });
}
