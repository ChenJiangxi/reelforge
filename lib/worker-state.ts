// 渲染机的实时状态(心跳带来的):最后一次出现的时间、手上在做什么、磁盘剩多少。
// 只放内存 —— 服务重启就清空,worker 5 秒内会再报一次,不用存盘。
export type WorkerJob = {
  stageId: string;
  projectId: string;
  kind: string;
  beat: string | null;
  step: string | null;
  total: number | null;
  upload: { label: string; sent: number; total: number } | null;
  startedAt: number | null;
};

type State = { lastSeen: number; diskGB: number | null; jobs: WorkerJob[]; jobsAt: number };
const g = globalThis as unknown as { __rfWorker?: State };
const state: State = (g.__rfWorker ??= { lastSeen: 0, diskGB: null, jobs: [], jobsAt: 0 });

export function workerSeen() {
  state.lastSeen = Date.now();
}

export function workerBeat(body: { jobs?: WorkerJob[]; diskGB?: number }) {
  state.lastSeen = Date.now();
  state.jobsAt = Date.now();
  state.jobs = Array.isArray(body.jobs) ? body.jobs.slice(0, 10) : [];
  if (typeof body.diskGB === "number") state.diskGB = body.diskGB;
}

export function workerStatus() {
  const ago = state.lastSeen ? Math.round((Date.now() - state.lastSeen) / 1000) : null;
  return {
    lastSeen: state.lastSeen || null,
    agoSec: ago,
    online: ago != null && ago < 120,
    diskGB: state.diskGB,
    // 心跳超过 30 秒没更新,进度就当不知道(别显示一个卡住的"上传 60%")
    jobs: Date.now() - state.jobsAt < 30_000 ? state.jobs : [],
  };
}
