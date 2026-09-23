// 数据类镜头:大数字、圆环分数、柱状图、时间线。数字必须是台词或参考材料里真有的(规划时校验)。
import React from "react";
import { Easing, interpolate } from "remotion";
import { Content, Kicker, clamp01, fitBlock, fitSize, pop, ramp, splitNumber, textEm, useF, useShot } from "../kit";

const fmt = (n: number, d: number) => (d ? n.toFixed(d) : String(Math.round(n)));

// ── number:大数字滚出来(年份逐位翻,其它从 0 数上去)────────────────
export const BigNumber: React.FC<{ p: { kicker?: string; value: string; unit?: string; note?: string } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const sn = splitNumber(p.value);
  const at = Number.isFinite(ctx.cues[0]) ? ctx.cues[0] : 6;
  const isYear = !!sn && !sn.decimals && sn.num >= 1900 && sn.num <= 2100 && !sn.pre && !sn.post;
  const maxW = stage.W * 0.86;
  const unit = p.unit || (sn ? sn.post : "");
  const shown = sn ? `${sn.pre}${sn.raw}` : String(p.value);
  const size = fitSize(shown + " ".repeat(unit ? 1 : 0), maxW - textEm(unit) * 0.34 * 300 * stage.u, 340 * stage.u, 130 * stage.u);
  const k = ramp(f, at, at + 28);
  const bar = ramp(f, at + 16, at + 36);
  const noteK = pop(f, at + 22, { damping: 16 });
  const note = fitBlock(p.note || "", maxW, 52 * stage.u, 34 * stage.u, 2);
  let digits: React.ReactNode;
  if (isYear && sn) {
    digits = [...sn.raw].map((d, i) => {
      const s = pop(f, at + i * 4, { damping: 12, stiffness: 170 }, 22);
      return (
        <span key={i} style={{ display: "inline-block", opacity: clamp01(s * 1.5), transform: `translateY(${(1 - s) * 0.5 * size}px)` }}>
          {d}
        </span>
      );
    });
  } else if (sn) {
    digits = `${sn.pre}${fmt(sn.num * k, sn.decimals)}`;
  } else {
    digits = <span style={{ opacity: k }}>{p.value}</span>;
  }
  return (
    <>
      <div style={{ position: "absolute", inset: 0, opacity: k, background: `radial-gradient(closest-side at 50% 42%, ${th.glow}, rgba(0,0,0,0) 68%)` }} />
      <Content gap={24 * stage.u}>
        <Kicker text={p.kicker} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 * stage.u, whiteSpace: "nowrap" }}>
          <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: size, lineHeight: 1.05, color: th.accentHi, letterSpacing: -size * 0.01, textShadow: `0 0 ${80 * stage.u}px ${th.glow}`, fontVariantNumeric: "tabular-nums" }}>
            {digits}
          </div>
          {unit ? <div style={{ fontFamily: th.sans, fontWeight: 700, fontSize: Math.round(size * 0.3), color: th.accent, opacity: k }}>{unit}</div> : null}
        </div>
        <div style={{ width: maxW * 0.3 * bar, height: 5 * stage.u, borderRadius: 3, background: th.accent, opacity: bar }} />
        {p.note ? (
          <div style={{ textAlign: "center", opacity: clamp01(noteK * 1.4), transform: `translateY(${(1 - noteK) * 14}px)` }}>
            {note.lines.map((l, i) => (
              <div key={i} style={{ fontFamily: th.sans, fontSize: note.size, lineHeight: 1.45, color: th.sub }}>
                {l}
              </div>
            ))}
          </div>
        ) : null}
      </Content>
    </>
  );
};

// ── gauge:圆环扫到分数,中间的数一起数上去 ─────────────────────────
export const Gauge: React.FC<{ p: { value: number | string; max?: number; label?: string; note?: string; kicker?: string } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const sn = splitNumber(p.value);
  const max = Number(p.max) > 0 ? Number(p.max) : 100;
  const v = sn ? Math.max(0, Math.min(max, sn.num)) : 0;
  const at = Number.isFinite(ctx.cues[0]) ? ctx.cues[0] : 6;
  const k = ramp(f, at, at + 34);
  const R = 320 * stage.u;
  const SW = 34 * stage.u;
  const C = 2 * Math.PI * R;
  const frac = (v / max) * k;
  const size = R * 2 + SW * 2 + 40 * stage.u;
  const cx = size / 2;
  const ang = -Math.PI / 2 + frac * 2 * Math.PI;
  const tip = { x: cx + R * Math.cos(ang), y: cx + R * Math.sin(ang) };
  const noteK = pop(f, at + 30, { damping: 16 });
  const note = fitBlock(p.note || "", stage.W * 0.82, 50 * stage.u, 34 * stage.u, 2);
  const gid = `g${th.id}`;
  return (
    <Content gap={34 * stage.u}>
      <Kicker text={p.kicker} />
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={th.accentDim} />
              <stop offset="100%" stopColor={th.accentHi} />
            </linearGradient>
          </defs>
          {Array.from({ length: 60 }).map((_, i) => {
            const a = -Math.PI / 2 + (i / 60) * 2 * Math.PI;
            const r1 = R + SW * 0.9;
            const r2 = r1 + (i % 5 === 0 ? 16 : 8) * stage.u;
            const lit = i / 60 <= frac;
            return <line key={i} x1={cx + r1 * Math.cos(a)} y1={cx + r1 * Math.sin(a)} x2={cx + r2 * Math.cos(a)} y2={cx + r2 * Math.sin(a)} stroke={lit ? th.accent : th.faint} strokeWidth={2 * stage.u} opacity={ramp(f, 0, 12)} />;
          })}
          <circle cx={cx} cy={cx} r={R} fill="none" stroke={th.faint} strokeWidth={SW} opacity={0.7} />
          <circle
            cx={cx}
            cy={cx}
            r={R}
            fill="none"
            stroke={`url(#${gid})`}
            strokeWidth={SW}
            strokeLinecap="round"
            strokeDasharray={`${C * frac} ${C}`}
            transform={`rotate(-90 ${cx} ${cx})`}
          />
          {frac > 0.01 ? <circle cx={tip.x} cy={tip.y} r={SW * 0.62} fill={th.accentHi} style={{ filter: `drop-shadow(0 0 ${18 * stage.u}px ${th.accentHi})` }} /> : null}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: 210 * stage.u, lineHeight: 1, color: th.accentHi, fontVariantNumeric: "tabular-nums", textShadow: `0 0 ${60 * stage.u}px ${th.glow}` }}>
            {sn ? fmt(v * k, sn.decimals) : p.value}
          </div>
          {p.label ? <div style={{ marginTop: 18 * stage.u, fontFamily: th.sans, fontSize: 44 * stage.u, letterSpacing: 6 * stage.u, color: th.muted }}>{p.label}</div> : null}
        </div>
      </div>
      {p.note ? (
        <div style={{ textAlign: "center", opacity: clamp01(noteK * 1.4), transform: `translateY(${(1 - noteK) * 14}px)` }}>
          {note.lines.map((l, i) => (
            <div key={i} style={{ fontFamily: th.sans, fontSize: note.size, lineHeight: 1.45, color: th.sub }}>
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </Content>
  );
};

type BarItem = { label: string; value: number | string; tag?: string };

// ── bars:柱子依次长出来,然后把要说的那几根点亮 ─────────────────────
export const Bars: React.FC<{ p: { title?: string; items: BarItem[]; highlight?: string[]; unit?: string } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage, dur } = ctx;
  const items = (p.items || []).filter((x) => x && x.label != null).slice(0, 10);
  const vals = items.map((x) => splitNumber(x.value)?.num ?? 0);
  const maxV = Math.max(1, ...vals);
  const hl = new Set(p.highlight?.length ? p.highlight : [items[vals.indexOf(Math.max(...vals))]?.label]);
  const growAt = Number.isFinite(ctx.cues[0]) ? ctx.cues[0] : 6;
  const hlAt = Number.isFinite(ctx.cues[1]) ? ctx.cues[1] : Math.max(growAt + 30, Math.round(dur * 0.45));
  const lit = ramp(f, hlAt, hlAt + 12);
  const horizontal = items.length <= 6 && Math.max(...items.map((x) => textEm(String(x.label)))) > 3;
  const padX = 80 * stage.u;
  const areaW = stage.W - padX * 2;

  if (horizontal) {
    const labelW = Math.min(areaW * 0.32, Math.max(...items.map((x) => textEm(String(x.label)))) * 44 * stage.u + 10);
    const barMax = areaW - labelW - 150 * stage.u;
    const rowH = 132 * stage.u;
    return (
      <Content gap={40 * stage.u}>
        <Kicker text={p.title} />
        <div style={{ width: areaW }}>
          {items.map((it, i) => {
            const g = pop(f, growAt + i * 4, { damping: 17, stiffness: 150 }, 26);
            const isH = hl.has(it.label);
            const col = isH ? th.accentHi : th.accentDim;
            const w = (vals[i] / maxV) * barMax * g;
            const size = fitSize(String(it.label), labelW, 44 * stage.u, 26 * stage.u);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", height: rowH, opacity: clamp01(g * 2) * (isH ? 1 : 1 - 0.45 * lit) }}>
                <div style={{ width: labelW, fontFamily: th.sans, fontSize: size, color: isH ? th.text : th.sub, whiteSpace: "nowrap" }}>{it.label}</div>
                <div style={{ height: 40 * stage.u, width: w, borderRadius: 20 * stage.u, background: col, boxShadow: isH && lit > 0.2 ? `0 0 ${24 * lit * stage.u}px ${th.accentHi}` : "none" }} />
                <div style={{ marginLeft: 20 * stage.u, fontFamily: th.sans, fontWeight: 800, fontSize: 48 * stage.u, color: col, fontVariantNumeric: "tabular-nums" }}>
                  {fmt(vals[i] * g, splitNumber(it.value)?.decimals ?? 0)}
                  {p.unit ? <span style={{ fontSize: 28 * stage.u, marginLeft: 4 }}>{p.unit}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </Content>
    );
  }

  const n = Math.max(1, items.length);
  const gap = (n > 7 ? 22 : 36) * stage.u;
  const bw = Math.min(130 * stage.u, (areaW - gap * (n - 1)) / n);
  const maxH = 760 * stage.u;
  return (
    <Content gap={50 * stage.u}>
      <Kicker text={p.title} />
      <div style={{ display: "flex", alignItems: "flex-end", gap, height: maxH + 90 * stage.u }}>
        {items.map((it, i) => {
          const g = pop(f, growAt + i * 3, { damping: 17, stiffness: 150 }, 24);
          const isH = hl.has(it.label);
          const col = isH ? th.accentHi : th.faint;
          const h = Math.max(6, (vals[i] / maxV) * maxH * g);
          return (
            <div key={i} style={{ width: bw, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end" }}>
              <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: Math.min(46, bw * 0.42) * (stage.u > 0 ? 1 : 1), color: isH ? th.accentHi : th.muted, opacity: g * (isH ? 1 : 1 - 0.4 * lit), marginBottom: 10 * stage.u, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {fmt(vals[i] * g, splitNumber(it.value)?.decimals ?? 0)}
              </div>
              <div
                style={{
                  width: bw,
                  height: h,
                  borderRadius: Math.min(16, bw * 0.18),
                  background: isH ? `linear-gradient(180deg, ${th.accentHi}, ${th.accent})` : col,
                  opacity: isH ? 0.55 + 0.45 * Math.max(lit, 0.3) : 0.9 - 0.35 * lit,
                  boxShadow: isH && lit > 0.2 ? `0 0 ${26 * lit * stage.u}px ${th.accent}` : "none",
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap, marginTop: -26 * stage.u }}>
        {items.map((it, i) => {
          const isH = hl.has(it.label);
          return (
            <div key={i} style={{ width: bw, textAlign: "center" }}>
              <div style={{ fontFamily: th.sans, fontSize: fitSize(String(it.label), bw + gap * 0.8, 32 * stage.u, 18 * stage.u), color: isH ? th.text : th.muted, whiteSpace: "nowrap" }}>{it.label}</div>
              {it.tag ? (
                <div style={{ marginTop: 6 * stage.u, fontFamily: th.sans, fontSize: fitSize(String(it.tag), bw + gap * 0.8, 28 * stage.u, 18 * stage.u), color: isH ? th.accent : th.muted, opacity: isH ? 1 : 0.7, whiteSpace: "nowrap" }}>{it.tag}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Content>
  );
};

type Pt = { label: string; value?: number | string; note?: string };

// ── timeline:镜头沿时间轴横移(缓起→冲刺→急刹),停在要说的那一格再推近 ─────
export const Timeline: React.FC<{ p: { title?: string; points: Pt[]; peak?: string } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage, dur } = ctx;
  const pts = (p.points || []).filter((x) => x && x.label != null).slice(0, 12);
  const n = Math.max(1, pts.length);
  const vals = pts.map((x) => splitNumber(x.value ?? "")?.num);
  const hasVals = vals.some((v) => v != null);
  let peak = pts.findIndex((x) => String(x.label) === String(p.peak ?? ""));
  if (peak < 0) peak = hasVals ? vals.indexOf(Math.max(...vals.map((v) => v ?? -Infinity))) : n - 1;
  const maxV = Math.max(1, ...vals.map((v) => v ?? 0));
  const u = stage.u;
  const GAP = 360 * u;
  const X0 = stage.W / 2;
  const axisY = stage.top + (stage.H - stage.top - stage.bottom) * 0.66;
  const start = 8;
  const stop = Number.isFinite(ctx.cues[0]) ? Math.max(start + 20, ctx.cues[0]) : Math.max(start + 30, Math.min(dur - 20, Math.round(dur * 0.6)));
  const camAt = (fr: number) => {
    const t = interpolate(fr, [start, stop], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const e = interpolate(t, [0, 0.15, 0.88, 1], [0, 0.055, 0.9, 1], { easing: Easing.inOut(Easing.quad) });
    return e * GAP * peak;
  };
  const camX = camAt(f);
  const popFrame = (i: number) => {
    if (i === 0) return start - 4;
    for (let fr = start; fr <= stop; fr++) if (camAt(fr) >= GAP * i - stage.W * 0.42) return fr;
    return stop;
  };
  const zoom = interpolate(f, [stop, stop + 18], [1, 1.2], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = ramp(f, stop, stop + 16);
  const miniW = stage.W * 0.78;
  const miniH = 150 * u;
  const miniY = stage.top + 110 * u;
  const draw = ramp(f, 4, 36);
  const mp = (i: number) => [(stage.W - miniW) / 2 + (n > 1 ? (i / (n - 1)) * miniW : miniW / 2), miniY + miniH - ((vals[i] ?? 0) / maxV) * miniH];
  return (
    <>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom})`, transformOrigin: `50% ${(axisY / stage.H) * 100 - 8}%` }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: X0 + GAP * n + stage.W, height: stage.H, transform: `translateX(${-camX}px)` }}>
            <div style={{ position: "absolute", left: 0, top: axisY - 3 * u, width: X0 + GAP * (n - 1) + stage.W, height: 6 * u, background: th.faint, borderRadius: 3 }} />
            {Array.from({ length: n * 5 + 10 }).map((_, i) => (
              <div key={i} style={{ position: "absolute", left: X0 - GAP + i * (GAP / 5) - 2 * u, top: axisY - 10 * u, width: 4 * u, height: 20 * u, background: th.faint, opacity: 0.6, borderRadius: 2 }} />
            ))}
            {pts.map((pt, i) => {
              const isP = i === peak;
              const pf = popFrame(i);
              const s = pop(f, pf, { damping: 11, stiffness: 160 }, 26);
              if (f < pf) return null;
              const h = hasVals ? 110 * u + ((vals[i] ?? 0) / maxV) * 300 * u : 200 * u;
              const roll = isP && vals[i] != null ? Math.round(interpolate(f, [stop - 4, stop + 22], [0, vals[i] as number], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) })) : vals[i];
              const cardW = 240 * u;
              return (
                <div key={i} style={{ position: "absolute", left: X0 + i * GAP, top: 0 }}>
                  <div style={{ position: "absolute", left: -4 * u, top: axisY - 20 * u, width: 8 * u, height: 40 * u, background: isP ? th.accentHi : th.accentDim, borderRadius: 4 }} />
                  <div style={{ position: "absolute", left: -cardW / 2, top: axisY + 40 * u, width: cardW, textAlign: "center", fontFamily: th.sans, fontWeight: 700, fontSize: fitSize(String(pt.label), cardW, 48 * u, 26 * u), color: isP ? th.accentHi : th.muted, whiteSpace: "nowrap" }}>
                    {pt.label}
                  </div>
                  {pt.note ? (
                    <div style={{ position: "absolute", left: -cardW / 2, top: axisY + 104 * u, width: cardW, textAlign: "center", fontFamily: th.serif, fontSize: fitSize(String(pt.note), cardW, 34 * u, 22 * u), color: isP ? th.accent : th.muted, opacity: 0.85, whiteSpace: "nowrap" }}>
                      {pt.note}
                    </div>
                  ) : null}
                  <div style={{ position: "absolute", left: -cardW / 2, top: axisY - 30 * u - h, width: cardW, height: h, transform: `scaleY(${s}) scaleX(${0.62 + 0.38 * s})`, transformOrigin: "50% 100%", opacity: clamp01(s * 2) }}>
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        borderRadius: 24 * u,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        background: isP ? th.cardHi : th.card,
                        border: `${2 * u}px solid ${isP ? th.accent : th.cardBorder}`,
                        boxShadow: isP ? `0 0 ${60 * u}px ${th.glow}` : "none",
                      }}
                    >
                      {vals[i] != null ? (
                        <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: (isP ? 92 : 66) * u, color: isP ? th.accentHi : th.sub, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{roll}</div>
                      ) : (
                        <div style={{ width: 22 * u, height: 22 * u, borderRadius: 11 * u, background: isP ? th.accentHi : th.accentDim }} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: glow * 0.5, background: `radial-gradient(closest-side at 50% ${(axisY / stage.H) * 100 - 10}%, ${th.glow}, rgba(0,0,0,0) 70%)` }} />
      <div style={{ position: "absolute", top: stage.top + 20 * u, left: 0, right: 0 }}>
        <Kicker text={p.title} />
      </div>
      {hasVals ? (
        <svg width={stage.W} height={miniY + miniH + 50 * u} style={{ position: "absolute", left: 0, top: 0 }}>
          <polyline points={pts.map((_, i) => mp(i).join(",")).join(" ")} fill="none" stroke={th.faint} strokeWidth={4 * u} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={4000} strokeDashoffset={4000 * (1 - draw)} />
          {pts.map((_, i) => {
            const [x, y] = mp(i);
            return <circle key={i} cx={x} cy={y} r={(i === peak ? 9 : 5) * u} fill={i === peak ? th.accentHi : th.muted} opacity={draw} />;
          })}
        </svg>
      ) : null}
    </>
  );
};


