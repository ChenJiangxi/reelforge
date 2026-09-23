"use client";

import { useEffect, useState } from "react";

export type Status = {
  worker: { online: boolean; agoSec: number | null; lastSeen: number | null; diskGB: number | null };
  claimable: number;
  jobs: {
    stageId: string;
    kind: string;
    beat: string | null;
    step: string | null;
    total: number | null;
    upload: { label: string; sent: number; total: number } | null;
    startedAt: number | null;
  }[];
};

// 渲染机状态 + 实时进度。有活在做的时候 3 秒拉一次,闲着 15 秒一次;标签页不在前台就不拉。
export function useStatus(projectId?: string, busy = true): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch(`/api/status${projectId ? `?project=${projectId}` : ""}`);
          if (r.ok && alive) setS(await r.json());
        } catch {
          /* 下次再拉 */
        }
      }
      if (alive) timer = setTimeout(tick, busy ? 3000 : 15000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, busy]);
  return s;
}
