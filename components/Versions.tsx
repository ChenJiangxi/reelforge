"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RESTORABLE, stageLabel, type Version } from "@/lib/stages";

const when = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 标题栏上的「版本 v3」按钮 + 下拉列表 */
export function VersionButton({ history, viewing, onPick }: { history: Version[]; viewing: number | null; onPick: (v: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const cur = history[history.length - 1];
  return (
    <span className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full border px-3 py-1 text-xs hover:border-foreground/30 ${viewing != null ? "border-accent/60 text-accent" : "border-border text-muted-foreground"}`}
        title="这一步最近几版:看、对比、退回"
      >
        版本 v{viewing ?? cur.v}
        {viewing != null ? "(旧版)" : ""} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-80 rounded-md border border-border bg-card p-1 text-xs shadow-sm">
          {[...history].reverse().map((h) => {
            const isCur = h.v === cur.v;
            return (
              <button
                key={h.v}
                onClick={() => {
                  onPick(isCur ? null : h.v);
                  setOpen(false);
                }}
                className={`block w-full rounded px-2 py-1.5 text-left hover:bg-muted ${viewing === h.v || (viewing == null && isCur) ? "bg-muted" : ""}`}
              >
                <span className="font-mono text-[11px]">v{h.v}</span>
                <span className="ml-1.5 text-muted-foreground">{when(h.ts)}</span>
                {isCur && <span className="ml-1.5 text-accent">当前</span>}
                {h.warn > 0 && <span className="ml-1.5 text-accent">{h.warn} 条标黄</span>}
                <span className="block truncate text-[11px] text-muted-foreground">{h.reason}</span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/** 看某个旧版:它的产物、和当前并排对比、退回 */
export function VersionView({
  stageId,
  kind,
  history,
  v,
  vertical,
  onClose,
}: {
  stageId: string;
  kind: string;
  history: Version[];
  v: number;
  vertical: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const old = history.find((h) => h.v === v);
  const cur = history[history.length - 1];
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  if (!old) return null;

  async function restore() {
    setBusy(true);
    setErr("");
    const r = await fetch("/api/stage/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageId, v }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      setErr(d.error ?? "没退成:网络断了");
      return;
    }
    onClose();
    router.refresh();
  }
  const playBoth = () => {
    for (const el of [a.current, b.current]) {
      if (!el) continue;
      el.currentTime = 0;
      el.play().catch(() => {});
    }
  };

  const media = (h: Version, ref?: React.Ref<HTMLVideoElement>) =>
    h.video ? (
      <video ref={ref} key={h.video} controls src={h.video} className={`rounded-md border border-border bg-black ${vertical ? "max-h-[60vh] w-auto" : "w-full"}`} />
    ) : h.audio ? (
      <audio controls src={h.audio} className="w-72" />
    ) : h.cover ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={h.cover} alt="封面" className="max-h-[50vh] rounded-md border border-border" />
    ) : h.script ? (
      <pre className="max-h-[55vh] max-w-xl overflow-y-auto whitespace-pre-wrap rounded bg-card p-3 text-xs leading-relaxed">{h.script}</pre>
    ) : (
      <div className="text-muted-foreground">这一版没有可以预览的产物</div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2 border-l-2 border-accent bg-accent-soft/40 px-3 py-2 text-xs">
        <span className="font-medium">
          正在看「{stageLabel(kind)}」v{old.v} · {when(old.ts)}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={old.reason}>
          {old.reason}
        </span>
        <button onClick={() => setCompare((c) => !c)} className="rounded-full border border-border px-2.5 py-0.5 hover:border-foreground/30">
          {compare ? "只看旧版" : `和当前 v${cur.v} 对比`}
        </button>
        {RESTORABLE.has(kind) ? (
          <button disabled={busy} onClick={restore} className="rounded-full bg-foreground px-2.5 py-0.5 text-background hover:opacity-85 disabled:opacity-40">
            {busy ? "退回中…" : kind === "edit" ? "退回这一版(放回当时的参数重剪)" : "退回这一版"}
          </button>
        ) : (
          <span className="text-muted-foreground">这一步的旧版只能看:中间文件每次都会被覆盖,退回了也对不上</span>
        )}
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          回到当前
        </button>
      </div>
      {err && <div className="mb-2 text-xs text-destructive">{err}</div>}
      {compare ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {old.video && cur.video && (
            <button onClick={playBoth} className="self-center rounded-full border border-border px-3 py-0.5 text-xs hover:border-foreground/30">
              两版一起从头播
            </button>
          )}
          <div className="flex min-h-0 flex-1 justify-center gap-3">
            <figure className="flex flex-col items-center gap-1">
              <figcaption className="text-xs text-muted-foreground">v{old.v}(旧)</figcaption>
              {media(old, a)}
            </figure>
            <figure className="flex flex-col items-center gap-1">
              <figcaption className="text-xs text-accent">v{cur.v}(当前)</figcaption>
              {media(cur, b)}
            </figure>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 justify-center">{media(old)}</div>
      )}
    </div>
  );
}
