"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type TlBeat = {
  name: string;
  text: string;
  image?: string;
  start: number;
  dur: number; // 念多久
  gap: number; // 念完停多久(含插进来的纯画面)
  baseGap: number; // 停顿本身(不含纯画面),拖缝改的是它
  gapOverridden: boolean;
  voiceStart: number; // 这拍在配音音频里的位置(波形图按它切)
};
export type TlInsert = { id: string; asset: string; kind: "overlay" | "gap"; mode: "full" | "pip"; start: number; end: number; clip: string; pending?: boolean };

const ASSET_MIME = "application/x-rf-asset";

// 时间轴(学 chatcut 的多轨):画面 / 插入 / 配音 / 字幕 四轨按真实时长排,播放头和视频联动。
// - 素材库里的素材拖到画面轨上 → 弹一个小菜单,选怎么插(从这里盖上去 / 画中画 / 整拍换掉 / 两拍之间插纯画面),
//   不猜你的意思
// - 两拍之间的缝左右拖 = 改这拍念完之后停多久(只重剪,不重配音);双击缝恢复原样
// - 插进来的块:拖动挪位置、点开改时长/全屏或画中画/删除
export function Timeline({
  projectId,
  beats,
  inserts,
  wave,
  voiceTotal,
  subs = [],
}: {
  projectId: string;
  beats: TlBeat[];
  inserts: TlInsert[];
  wave?: string;
  voiceTotal: number;
  subs?: { text: string; start: number; end: number }[];
}) {
  const router = useRouter();
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [gapDrag, setGapDrag] = useState<{ name: string; value: number } | null>(null);
  const [moveDrag, setMoveDrag] = useState<{ id: string; dx: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ t: number; boundary: number | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; t: number; boundary: number | null; asset: string; beatIdx: number } | null>(null);
  const [openIns, setOpenIns] = useState<string | null>(null);

  // 拖缝时实时重排:后面每拍的开始时间跟着挪
  const gaps = beats.map((b) => (gapDrag?.name === b.name ? gapDrag.value + (b.gap - b.baseGap) : b.gap));
  const shifts = gaps.reduce<number[]>((acc, g, i) => [...acc, (i ? acc[i - 1] : 0) + (i ? gaps[i - 1] - beats[i - 1].gap : 0)], []);
  const laid = beats.map((b, i) => ({ ...b, start: b.start + shifts[i], gap: gaps[i] }));
  const total = laid.length ? laid[laid.length - 1].start + laid[laid.length - 1].dur + laid[laid.length - 1].gap : 1;
  const pps = Math.max(1.5, (width - 16) / Math.max(1, total)) * zoom;
  const X = (t: number) => t * pps;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const on = (e: Event) => setNow((e as CustomEvent<number>).detail);
    window.addEventListener("rf-time", on);
    return () => window.removeEventListener("rf-time", on);
  }, []);

  const seek = (t: number) => window.dispatchEvent(new CustomEvent("rf-seek", { detail: Math.max(0, t) }));
  const tAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return (clientX - r.left + el.scrollLeft) / pps;
  };

  async function post(url: string, body: unknown) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? `没改成(服务器返回 ${r.status})`);
      }
    } catch {
      setErr("没改成:网络断了");
    }
    setBusy(false);
    router.refresh();
  }
  const insert = (body: Record<string, unknown>) => post(`/api/project/${projectId}/insert`, body);

  // ── 刻度 ──
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => s * pps >= 56) ?? 60;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  const contentW = Math.ceil(X(total)) + 16;

  // ── 拖素材进来 ──
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
    e.preventDefault();
    const t = tAt(e.clientX);
    // 离某个缝 10px 以内 → 可以插在两拍之间当纯画面
    const bi = laid.findIndex((b) => Math.abs(X(b.start + b.dur + b.gap) - X(t)) < 10);
    setDropHint({ t, boundary: bi >= 0 && bi < laid.length - 1 ? bi : null });
  };
  const onDrop = (e: React.DragEvent) => {
    const asset = e.dataTransfer.getData(ASSET_MIME);
    e.preventDefault();
    const t = tAt(e.clientX);
    const bi = laid.findIndex((b) => t >= b.start && t < b.start + b.dur + b.gap);
    const el = scroller.current!;
    const x = e.clientX - el.getBoundingClientRect().left;
    setMenu(asset ? { x, t, boundary: dropHint?.boundary ?? null, asset, beatIdx: bi < 0 ? laid.length - 1 : bi } : null);
    setDropHint(null);
  };

  // ── 拖缝改停顿 ──
  const startGapDrag = (b: TlBeat) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const g0 = b.baseGap;
    let val = g0;
    const move = (ev: PointerEvent) => {
      val = Math.min(3, Math.max(0.05, g0 + (ev.clientX - x0) / pps));
      setGapDrag({ name: b.name, value: val });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGapDrag(null);
      if (Math.abs(val - g0) >= 0.03) post(`/api/project/${projectId}/override`, { clip: b.name, set: { gap: Number(val.toFixed(2)) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── 拖插入块挪位置 ──
  const startMove = (ins: TlInsert) => (e: React.PointerEvent) => {
    if (ins.kind === "gap") return; // 纯画面跟着它那段停顿走,挪不了
    e.stopPropagation();
    const x0 = e.clientX;
    let dx = 0;
    const move = (ev: PointerEvent) => {
      dx = ev.clientX - x0;
      setMoveDrag({ id: ins.id, dx });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMoveDrag(null);
      if (Math.abs(dx) > 4) insert({ op: "update", id: ins.id, t: Number(Math.max(0, ins.start + dx / pps).toFixed(2)) });
      else setOpenIns(openIns === ins.id ? null : ins.id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const lane = "relative h-9 border-b border-border/50";
  const label = "flex h-9 items-center border-b border-border/50 pr-1 font-mono text-[10px] text-muted-foreground";

  return (
    <div className="border-t border-border/70 text-xs">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="font-medium">时间轴</span>
        <span className="font-mono text-[10px] text-muted-foreground">{total.toFixed(1)}s</span>
        <span className="text-[11px] text-muted-foreground">
          素材库里的素材拖到画面轨上插入 · 拖两拍之间的缝改停顿(双击恢复)
        </span>
        {busy && <span className="text-[11px] text-accent">提交中…</span>}
        {err && (
          <button onClick={() => setErr("")} className="truncate text-[11px] text-destructive" title="点一下关掉">
            {err}
          </button>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button onClick={() => setZoom((z) => Math.max(1, z / 2))} className="rounded px-1.5 text-muted-foreground hover:bg-muted" title="缩小">
            −
          </button>
          <span className="w-8 text-center font-mono text-[10px] text-muted-foreground">{zoom}x</span>
          <button onClick={() => setZoom((z) => Math.min(16, z * 2))} className="rounded px-1.5 text-muted-foreground hover:bg-muted" title="放大">
            +
          </button>
        </span>
      </div>
      <div className="flex">
        <div className="w-9 shrink-0 pl-2">
          <div className="h-5" />
          <div className={label}>插入</div>
          <div className="flex h-14 items-center border-b border-border/50 pr-1 font-mono text-[10px] text-muted-foreground">画面</div>
          <div className={label}>配音</div>
          <div className={label}>字幕</div>
        </div>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" onDragOver={onDragOver} onDragLeave={() => setDropHint(null)} onDrop={onDrop}>
          <div className="relative" style={{ width: contentW }}>
            {/* 刻度:点哪跳哪 */}
            <div className="relative h-5 cursor-pointer border-b border-border/50" onClick={(e) => seek(tAt(e.clientX))}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0.5 font-mono text-[9px] text-muted-foreground" style={{ left: X(t) + 2 }}>
                  {t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : `${t}s`}
                </span>
              ))}
            </div>
            {/* 插入轨 */}
            <div className={lane} onClick={(e) => e.target === e.currentTarget && seek(tAt(e.clientX))}>
              {inserts.map((ins) => {
                const left = X(ins.start) + (moveDrag?.id === ins.id ? moveDrag.dx : 0);
                return (
                  <div key={ins.id} className="absolute top-1" style={{ left, width: Math.max(10, X(ins.end - ins.start)) }}>
                    <div
                      onPointerDown={startMove(ins)}
                      className={`h-7 cursor-grab truncate rounded-sm border px-1 leading-7 ${
                        ins.pending ? "border-dashed border-accent/60 bg-accent-soft/50" : "border-accent/50 bg-accent-soft"
                      } text-[10px] text-accent`}
                      title={`${ins.asset} · ${ins.kind === "gap" ? "纯画面" : ins.mode === "pip" ? "画中画" : "全屏"} ${(ins.end - ins.start).toFixed(1)}s${ins.pending ? "(等重剪)" : ""}`}
                    >
                      {ins.kind === "gap" ? "▮ " : ins.mode === "pip" ? "◳ " : ""}
                      {ins.asset}
                    </div>
                    {openIns === ins.id && (
                      <div className="absolute left-0 top-8 z-20 w-56 rounded-md border border-border bg-card p-2 shadow-sm">
                        <div className="mb-1 truncate text-[11px] font-medium">{ins.asset}</div>
                        {ins.kind === "overlay" && (
                          <div className="mb-1 flex gap-1">
                            {(["full", "pip"] as const).map((m) => (
                              <button
                                key={m}
                                disabled={ins.mode === m || busy}
                                onClick={() => insert({ op: "update", id: ins.id, mode: m })}
                                className={`rounded-full px-2 py-0.5 text-[11px] ${ins.mode === m ? "bg-foreground text-background" : "bg-muted hover:bg-border"}`}
                              >
                                {m === "full" ? "全屏" : "画中画"}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="mb-1 flex flex-wrap items-center gap-1">
                          <span className="text-[11px] text-muted-foreground">时长</span>
                          {[2, 3, 5, 8].map((d) => (
                            <button key={d} disabled={busy} onClick={() => insert({ op: "update", id: ins.id, dur: d })} className="rounded-full bg-muted px-2 py-0.5 text-[11px] hover:bg-border">
                              {d}s
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <button disabled={busy} onClick={() => insert({ op: "remove", id: ins.id })} className="text-[11px] text-destructive hover:underline">
                            删掉
                          </button>
                          <button onClick={() => setOpenIns(null)} className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">
                            关
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 画面轨:每拍按时长排,缩略图当底;念完之后的停顿画成浅色尾巴,尾巴末端是可拖的缝 */}
            <div className="relative h-14 border-b border-border/50">
              {laid.map((b, i) => (
                <div key={b.name} className="absolute top-1 flex h-12" style={{ left: X(b.start), width: X(b.dur + b.gap) }}>
                  <button
                    onClick={(e) => seek(tAt(e.clientX))}
                    className="relative h-full overflow-hidden rounded-l-sm border border-border bg-muted bg-cover bg-center"
                    style={{ width: X(b.dur), backgroundImage: b.image ? `url(${b.image})` : undefined }}
                    title={`${b.name} · ${b.text}`}
                  >
                    <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-0.5 font-mono text-[9px] text-white">{i + 1}</span>
                  </button>
                  <div className={`h-full ${b.gapOverridden || gapDrag?.name === b.name ? "bg-accent/20" : "bg-muted/60"}`} style={{ width: X(b.gap) }} title={`念完停 ${b.gap.toFixed(2)}s`} />
                  {i < laid.length - 1 && (
                    <div
                      onPointerDown={startGapDrag(b)}
                      onDoubleClick={() => post(`/api/project/${projectId}/override`, { clip: b.name, unset: ["gap"] })}
                      className={`absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize ${dropHint?.boundary === i ? "bg-accent" : "hover:bg-accent/60"}`}
                      title={`拖:改 ${b.name} 念完之后停多久(现在 ${b.baseGap.toFixed(2)}s)· 双击恢复`}
                    />
                  )}
                  {gapDrag?.name === b.name && (
                    <span className="absolute -top-0.5 right-0 z-20 rounded bg-foreground px-1 font-mono text-[9px] text-background">{gapDrag.value.toFixed(2)}s</span>
                  )}
                </div>
              ))}
              {dropHint && dropHint.boundary == null && <div className="absolute top-0 z-10 h-full w-0.5 bg-accent" style={{ left: X(dropHint.t) }} />}
            </div>
            {/* 配音轨:波形按每拍在配音里的位置切开,摆到它在成片里的位置(停顿拉长了也对得上) */}
            <div className={lane}>
              {wave &&
                laid.map((b) => (
                  <div
                    key={b.name}
                    onClick={(e) => seek(tAt(e.clientX))}
                    className="absolute top-1 h-7 cursor-pointer bg-no-repeat opacity-90"
                    style={{
                      left: X(b.start),
                      width: X(b.dur),
                      backgroundImage: `url(${wave})`,
                      backgroundSize: `${X(voiceTotal)}px 100%`,
                      backgroundPosition: `${-X(b.voiceStart)}px 0`,
                    }}
                  />
                ))}
            </div>
            {/* 字幕轨 */}
            <div className={lane}>
              {subs.map((s, i) => (
                <div
                  key={i}
                  onClick={() => seek(s.start)}
                  title={s.text}
                  className="absolute top-1.5 flex h-6 cursor-pointer items-center overflow-hidden rounded-sm bg-accent/15 px-1 text-[10px] text-accent"
                  style={{ left: X(s.start), width: Math.max(4, X(s.end - s.start)) }}
                >
                  <span className="truncate">{s.text}</span>
                </div>
              ))}
            </div>
            {/* 播放头 */}
            <div className="pointer-events-none absolute top-0 z-10 h-full w-px bg-destructive" style={{ left: X(now) }} />
          </div>
          {/* 松手后的小菜单:怎么插由你选 */}
          {menu && (
            <div className="absolute top-6 z-30 w-60 rounded-md border border-border bg-card p-1.5 text-[11px] shadow-sm" style={{ left: Math.max(0, Math.min(menu.x, width - 250)) }}>
              <div className="truncate px-1.5 pb-1 font-medium">「{menu.asset}」插在 {menu.t.toFixed(1)}s</div>
              {[
                { label: "从这里盖上去 3 秒(全屏)", run: () => insert({ op: "add", t: menu.t, asset: menu.asset, mode: "full", dur: 3 }) },
                { label: "从这里画中画 3 秒", run: () => insert({ op: "add", t: menu.t, asset: menu.asset, mode: "pip", dur: 3 }) },
                ...(menu.boundary != null
                  ? [{ label: `第 ${menu.boundary + 1}、${menu.boundary + 2} 拍之间插 3 秒纯画面(不念台词)`, run: () => insert({ op: "add", after: laid[menu.boundary!].name, asset: menu.asset, kind: "gap", dur: 3 }) }]
                  : []),
                { label: `整个第 ${menu.beatIdx + 1} 拍换成它(要重出素材)`, run: () => post(`/api/project/${projectId}/assign`, { clip: laid[menu.beatIdx].name, asset: menu.asset }) },
              ].map((o) => (
                <button
                  key={o.label}
                  onClick={() => {
                    setMenu(null);
                    o.run();
                  }}
                  className="block w-full rounded px-1.5 py-1 text-left hover:bg-muted"
                >
                  {o.label}
                </button>
              ))}
              <button onClick={() => setMenu(null)} className="block w-full rounded px-1.5 py-1 text-left text-muted-foreground hover:bg-muted">
                算了
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
