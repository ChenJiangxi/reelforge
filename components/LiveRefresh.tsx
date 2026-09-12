"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Keeps every page fresh without manual F5: poll lightly, and refresh
// immediately when she comes back to the tab. Mounted once in the layout
// (authed users only).
export function LiveRefresh({ intervalMs = 10000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const t = setInterval(tick, intervalMs);
    const onVis = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const onFocus = () => router.refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [router, intervalMs]);

  return null;
}
