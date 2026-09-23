"use client";

import { useStatus } from "@/components/useStatus";

function ago(sec: number) {
  if (sec < 120) return `${sec} 秒`;
  if (sec < 7200) return `${Math.round(sec / 60)} 分钟`;
  return `${Math.round(sec / 3600)} 小时`;
}

// 渲染机离线 / 磁盘快满时的顶部提示。只在"有活等着它"的时候才喊离线 —— 闲着没活时它离不离线都无所谓。
export function WorkerBanner() {
  const s = useStatus(undefined, false);
  if (!s) return null;
  const { worker, claimable } = s;
  if (!worker.online && claimable > 0) {
    const last = worker.lastSeen
      ? new Date(worker.lastSeen).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : null;
    return (
      <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
        渲染机{worker.agoSec != null ? ` ${ago(worker.agoSec)}` : "一直"}没来取活了{last ? `(最后一次 ${last})` : "(服务重启后还没见过它)"},
        有 {claimable} 个阶段在等它。多半是 macmini 睡着了、断网了,或者 pm2 里的 reelforge-worker 停了。
      </div>
    );
  }
  if (worker.online && worker.diskGB != null && worker.diskGB < 3) {
    return (
      <div className="border-b border-accent/30 bg-accent-soft/60 px-4 py-2 text-sm text-accent">
        渲染机磁盘只剩 {worker.diskGB} GB,剪辑和字幕开工要 2 GB 以上,快不够了。
      </div>
    );
  }
  return null;
}
