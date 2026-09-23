// 结构类镜头:逐条清单、结论+依据、左右对照、关系链、四柱、对照表
import React from "react";
import { Easing, interpolate } from "remotion";
import { Content, Chip, Kicker, clamp01, cueAt, fitBlock, fitSize, pop, ramp, useF, useShot } from "../kit";

type Item = { text: string; sub?: string };
const asItems = (xs: unknown): Item[] =>
  (Array.isArray(xs) ? xs : []).map((x) => (typeof x === "string" ? { text: x } : (x as Item))).filter((x) => x && x.text);

// ── list:编号清单,念到哪条出哪条,最新那条带金色竖条 ─────────────────
export const List: React.FC<{ p: { title?: string; items: Item[] | string[] } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const items = asItems(p.items).slice(0, 5);
  const u = stage.u;
  const w = stage.W - 150 * u;
  const numW = 96 * u;
  const textW = w - numW - 40 * u;
  const size = Math.min(...items.map((it) => fitBlock(it.text, textW, 64 * u, 40 * u, 2).size));
  const ats = items.map((_, i) => cueAt(ctx, i, items.length, 6));
  const current = ats.reduce((c, a, i) => (f >= a ? i : c), -1);
  return (
    <Content gap={46 * u}>
      <Kicker text={p.title} />
      <div style={{ width: w, display: "flex", flexDirection: "column", gap: 44 * u }}>
        {items.map((it, i) => {
          const s = pop(f, ats[i], { damping: 16, stiffness: 150, mass: 0.85 }, 24);
          const on = i === current;
          const blk = fitBlock(it.text, textW, size, size, 2);
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", opacity: f < ats[i] ? 0 : clamp01(s * 1.6) * (on ? 1 : 0.72), transform: `translateX(${(1 - s) * 50}px)`, position: "relative", paddingLeft: 26 * u }}>
              <div style={{ position: "absolute", left: 0, top: 6 * u, bottom: 6 * u, width: 6 * u, borderRadius: 3, background: th.accent, opacity: on ? 1 : 0 }} />
              <div style={{ width: numW, fontFamily: th.sans, fontWeight: 800, fontSize: 56 * u, lineHeight: `${size * 1.4}px`, color: on ? th.accentHi : th.accentDim, fontVariantNumeric: "tabular-nums" }}>{String(i + 1).padStart(2, "0")}</div>
              <div style={{ width: textW }}>
                {blk.lines.map((l, k) => (
                  <div key={k} style={{ fontFamily: th.sans, fontWeight: 600, fontSize: size, lineHeight: 1.4, color: on ? th.text : th.sub }}>
                    {l}
                  </div>
                ))}
                {it.sub ? <div style={{ marginTop: 6 * u, fontFamily: th.sans, fontSize: 34 * u, color: th.muted }}>{it.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Content>
  );
};

// ── evidence:结论先到(大字+分数),依据逐条汇入,最后收成完成态 ─────────
export const Evidence: React.FC<{ p: { head: string; side?: string; score?: string; label?: string; items: string[]; foot?: string } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const u = stage.u;
  const items = (p.items || []).filter(Boolean).slice(0, 4);
  const head = pop(f, 3, { damping: 15, stiffness: 170 }, 20);
  const w = stage.W - 150 * u;
  const ats = items.map((_, i) => cueAt(ctx, i, items.length, 18));
  const doneAt = (ats[ats.length - 1] ?? 18) + 20;
  const done = ramp(f, doneAt, doneAt + 14);
  const rowSize = Math.min(...items.map((r) => fitBlock(r, w - 60 * u, 52 * u, 34 * u, 2).size));
  const headSize = fitSize(p.head, w * (p.score ? 0.62 : 0.9), 136 * u, 64 * u);
  return (
    <Content justify="center">
      <div style={{ width: w }}>
        <div style={{ opacity: clamp01(head * 1.5), transform: `translateY(${(1 - head) * 18}px)`, display: "flex", alignItems: "baseline", gap: 20 * u, marginBottom: 18 * u }}>
          <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: headSize, color: th.accentHi, letterSpacing: 2, whiteSpace: "nowrap" }}>{p.head}</div>
          {p.side ? <div style={{ fontFamily: th.serif, fontSize: 58 * u, color: th.accent, whiteSpace: "nowrap" }}>{p.side}</div> : null}
          {p.score ? <div style={{ marginLeft: "auto", fontFamily: th.sans, fontWeight: 800, fontSize: 104 * u, color: th.accentHi, whiteSpace: "nowrap" }}>{p.score}</div> : null}
        </div>
        <div style={{ height: 3 * u, background: `linear-gradient(90deg, ${th.accent}, rgba(0,0,0,0))`, marginBottom: 46 * u, transform: `scaleX(${head})`, transformOrigin: "0 50%" }} />
        {p.label ? <div style={{ fontFamily: th.sans, fontSize: 36 * u, color: th.muted, letterSpacing: 10 * u, marginBottom: 30 * u, opacity: clamp01(head) }}>{p.label}</div> : null}
        {items.map((r, i) => {
          const s = pop(f, ats[i], { damping: 16, stiffness: 150, mass: 0.85 }, 24);
          if (f < ats[i]) return <div key={i} style={{ height: rowSize * 1.45 + 30 * u }} />;
          const blk = fitBlock(r, w - 60 * u, rowSize, rowSize, 2);
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 22 * u, marginBottom: 30 * u, opacity: clamp01(s * 1.6), transform: `translateX(${(1 - s) * 34}px)` }}>
              <div style={{ width: 18 * u, height: 18 * u, borderRadius: 9 * u, marginTop: rowSize * 0.45, flexShrink: 0, background: th.accent, boxShadow: `0 0 ${(10 + done * 14) * u}px ${th.accent}` }} />
              <div>
                {blk.lines.map((l, k) => (
                  <div key={k} style={{ fontFamily: th.sans, fontSize: rowSize, lineHeight: 1.45, color: th.sub }}>
                    {l}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {p.foot ? <div style={{ marginTop: 24 * u, opacity: done, fontFamily: th.sans, fontSize: 36 * u, color: th.accentDim, letterSpacing: 2 }}>{p.foot}</div> : null}
      </div>
    </Content>
  );
};

type Side = { title: string; lines?: string[] };

// ── compare:左右两张卡从两边进来,中间一枚 VS,下面落结论 ──────────────
export const Compare: React.FC<{ p: { left: Side; right: Side; verdict?: string; hl?: "left" | "right" | "none" } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const u = stage.u;
  const gap = 36 * u;
  const cw = (stage.W - 120 * u - gap) / 2;
  const a0 = cueAt(ctx, 0, 3, 4);
  const a1 = cueAt(ctx, 1, 3, 4);
  const a2 = cueAt(ctx, 2, 3, 4);
  const hl = p.hl ?? "right";
  const sides: [Side, number, number, boolean][] = [
    [p.left || { title: "" }, a0, -1, hl === "left"],
    [p.right || { title: "" }, a1, 1, hl === "right"],
  ];
  const lineSize = Math.min(
    ...sides.flatMap(([s]) => (s.lines || []).map((l) => fitBlock(l, cw - 70 * u, 50 * u, 30 * u, 2).size)),
    50 * u,
  );
  const vs = pop(f, a1 + 4, { damping: 12, stiffness: 190 }, 20);
  const verdict = pop(f, a2, { damping: 15 }, 22);
  const vBlk = fitBlock(p.verdict || "", stage.W * 0.82, 68 * u, 42 * u, 2);
  return (
    <Content gap={56 * u}>
      <div style={{ display: "flex", gap, position: "relative" }}>
        {sides.map(([s, at, dir, isH], i) => {
          const k = pop(f, at, { damping: 16, stiffness: 150 }, 26);
          const col = isH ? th.accentHi : th.sub;
          return (
            <div
              key={i}
              style={{
                width: cw,
                minHeight: 480 * u,
                borderRadius: 30 * u,
                padding: `${50 * u}px ${34 * u}px`,
                background: isH ? th.cardHi : th.card,
                border: `${2 * u}px solid ${isH ? th.accent : th.cardBorder}`,
                boxShadow: isH ? `0 0 ${60 * u}px ${th.glow}` : "none",
                opacity: f < at ? 0 : clamp01(k * 1.5),
                transform: `translateX(${(1 - k) * dir * 120}px)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: fitSize(s.title, cw - 60 * u, 92 * u, 44 * u), color: col, whiteSpace: "nowrap" }}>{s.title}</div>
              <div style={{ width: "40%", height: 3 * u, margin: `${26 * u}px 0 ${30 * u}px`, background: isH ? th.accent : th.faint }} />
              {(s.lines || []).slice(0, 4).map((l, k2) => {
                const blk = fitBlock(l, cw - 70 * u, lineSize, lineSize, 2);
                return (
                  <div key={k2} style={{ textAlign: "center", marginBottom: 22 * u, opacity: ramp(f, at + 8 + k2 * 5, at + 20 + k2 * 5) }}>
                    {blk.lines.map((x, j) => (
                      <div key={j} style={{ fontFamily: th.sans, fontSize: lineSize, lineHeight: 1.4, color: isH ? th.text : th.muted }}>
                        {x}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 70 * u,
            width: 96 * u,
            height: 96 * u,
            marginLeft: -48 * u,
            borderRadius: 48 * u,
            background: th.base,
            border: `${3 * u}px solid ${th.accent}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: th.sans,
            fontWeight: 800,
            fontSize: 38 * u,
            color: th.accentHi,
            opacity: clamp01(vs * 1.4),
            transform: `scale(${0.4 + 0.6 * vs})`,
          }}
        >
          VS
        </div>
      </div>
      {p.verdict ? (
        <div style={{ textAlign: "center", opacity: f < a2 ? 0 : clamp01(verdict * 1.5), transform: `translateY(${(1 - verdict) * 18}px)` }}>
          {vBlk.lines.map((l, i) => (
            <div key={i} style={{ fontFamily: th.sans, fontWeight: 800, fontSize: vBlk.size, lineHeight: 1.35, color: th.accentHi, textShadow: `0 0 ${40 * u}px ${th.glow}` }}>
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </Content>
  );
};

type Node = { label: string; sub?: string };

// ── diagram:关系链。两个节点横着摆,三四个竖着串;箭头在两次出现之间一笔画出来 ─────
export const Diagram: React.FC<{ p: { title?: string; nodes: Node[]; links?: string[] } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const u = stage.u;
  const nodes = (p.nodes || []).filter((x) => x && x.label).slice(0, 4);
  const links = p.links || [];
  const n = nodes.length;
  const ats = nodes.map((_, i) => cueAt(ctx, i, n, 4));
  const last = n - 1;
  const box = (nd: Node, i: number, w: number, h: number) => {
    const s = pop(f, ats[i], { damping: 14, stiffness: 160 }, 24);
    const isH = i === last;
    return (
      <div
        style={{
          width: w,
          height: h,
          borderRadius: 28 * u,
          background: isH ? th.cardHi : th.card,
          border: `${3 * u}px solid ${isH ? th.accent : th.cardBorder}`,
          boxShadow: isH ? `0 0 ${50 * u * s}px ${th.glow}` : "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: f < ats[i] ? 0 : clamp01(s * 1.5),
          transform: `scale(${0.8 + 0.2 * s})`,
        }}
      >
        <div style={{ fontFamily: th.sans, fontWeight: 800, fontSize: fitSize(nd.label, w - 40 * u, 84 * u, 40 * u), color: isH ? th.accentHi : th.text, whiteSpace: "nowrap" }}>{nd.label}</div>
        {nd.sub ? <div style={{ marginTop: 10 * u, fontFamily: th.sans, fontSize: fitSize(nd.sub, w - 40 * u, 38 * u, 22 * u), color: th.muted, whiteSpace: "nowrap" }}>{nd.sub}</div> : null}
      </div>
    );
  };
  const arrowK = (i: number) => (i + 1 < n ? ramp(f, ats[i] + 6, Math.max(ats[i] + 14, ats[i + 1] - 2), Easing.inOut(Easing.cubic)) : 0);
  const linkChip = (i: number) => {
    const t = links[i];
    if (!t) return null;
    const k = arrowK(i);
    return <Chip text={t} k={clamp01((k - 0.4) / 0.6)} color={th.accent} filled size={36 * u} />;
  };

  if (n <= 2) {
    const w = 360 * u;
    const h = 300 * u;
    const aw = stage.W - 100 * u - w * 2;
    return (
      <Content gap={70 * u}>
        <Kicker text={p.title} />
        <div style={{ display: "flex", alignItems: "center" }}>
          {box(nodes[0], 0, w, h)}
          <div style={{ width: aw, position: "relative", height: h, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width={aw} height={40 * u} style={{ position: "absolute", top: h / 2 + 20 * u }}>
              <line x1={10 * u} y1={20 * u} x2={10 * u + (aw - 40 * u) * arrowK(0)} y2={20 * u} stroke={th.accent} strokeWidth={5 * u} strokeLinecap="round" />
              {arrowK(0) > 0.95 ? <polygon points={`${aw - 30 * u},${6 * u} ${aw - 6 * u},${20 * u} ${aw - 30 * u},${34 * u}`} fill={th.accent} /> : null}
            </svg>
            <div style={{ position: "absolute", top: h / 2 - 60 * u }}>{linkChip(0)}</div>
          </div>
          {nodes[1] ? box(nodes[1], 1, w, h) : null}
        </div>
      </Content>
    );
  }

  const w = 720 * u;
  const h = 200 * u;
  const ah = 160 * u;
  return (
    <Content gap={40 * u}>
      <Kicker text={p.title} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {nodes.map((nd, i) => (
          <React.Fragment key={i}>
            {box(nd, i, w, h)}
            {i < last ? (
              <div style={{ height: ah, width: w, position: "relative" }}>
                <svg width={w} height={ah} style={{ position: "absolute", inset: 0 }}>
                  <line x1={w / 2} y1={12 * u} x2={w / 2} y2={12 * u + (ah - 44 * u) * arrowK(i)} stroke={th.accent} strokeWidth={5 * u} strokeLinecap="round" />
                  {arrowK(i) > 0.95 ? <polygon points={`${w / 2 - 16 * u},${ah - 34 * u} ${w / 2 + 16 * u},${ah - 34 * u} ${w / 2},${ah - 10 * u}`} fill={th.accent} /> : null}
                </svg>
                <div style={{ position: "absolute", left: w / 2 + 40 * u, top: ah / 2 - 30 * u }}>{linkChip(i)}</div>
              </div>
            ) : null}
          </React.Fragment>
        ))}
      </div>
    </Content>
  );
};

type Col = { head: string; top: string; bottom: string; note?: string };

// ── pillars:四柱像发牌一样一张张落下,要讲的那柱点亮 ──────────────────
export const Pillars: React.FC<{ p: { title?: string; cols: Col[]; mark?: string[] } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const u = stage.u;
  const cols = (p.cols || []).filter(Boolean).slice(0, 4);
  const n = Math.max(1, cols.length);
  const gap = 26 * u;
  const cw = Math.min(230 * u, (stage.W - 110 * u - gap * (n - 1)) / n);
  const ch = 680 * u;
  const marks = new Set(p.mark || []);
  const ats = cols.map((_, i) => cueAt(ctx, i, n, 6));
  const lit = ramp(f, (ats[n - 1] ?? 6) + 16, (ats[n - 1] ?? 6) + 30);
  return (
    <Content gap={50 * u}>
      <Kicker text={p.title} />
      <div style={{ display: "flex", gap }}>
        {cols.map((c, i) => {
          const s = pop(f, ats[i], { damping: 13, stiffness: 140, mass: 0.9 }, 28);
          const isM = marks.has(c.head);
          const hl = isM ? lit : 0;
          const rot = interpolate(s, [0, 1], [(i - (n - 1) / 2) * -10, 0]);
          return (
            <div
              key={i}
              style={{
                width: cw,
                height: ch,
                borderRadius: 26 * u,
                background: hl > 0.3 ? th.cardHi : th.card,
                border: `${2 * u}px solid ${hl > 0.3 ? th.accent : th.cardBorder}`,
                boxShadow: hl > 0.3 ? `0 0 ${50 * u * hl}px ${th.glow}` : `0 ${20 * u}px ${40 * u}px rgba(0,0,0,0.25)`,
                opacity: f < ats[i] ? 0 : clamp01(s * 1.8),
                transform: `translateY(${(1 - s) * 420 * u}px) rotate(${rot}deg)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "space-between",
                padding: `${30 * u}px 0 ${34 * u}px`,
              }}
            >
              <div style={{ fontFamily: th.sans, fontSize: 32 * u, letterSpacing: 4 * u, color: th.muted }}>{c.head}</div>
              <div style={{ fontFamily: th.serif, fontWeight: 700, fontSize: Math.min(140 * u, cw * 0.62), lineHeight: 1, color: isM ? th.accentHi : th.text }}>{c.top}</div>
              <div style={{ width: "46%", height: 2 * u, background: th.faint }} />
              <div style={{ fontFamily: th.serif, fontWeight: 700, fontSize: Math.min(140 * u, cw * 0.62), lineHeight: 1, color: isM ? th.accentHi : th.text }}>{c.bottom}</div>
              <div style={{ minHeight: 44 * u }}>{c.note ? <Chip text={c.note} k={clamp01(s)} color={isM ? th.accent : th.muted} filled={isM && hl > 0.5} size={28 * u} /> : null}</div>
            </div>
          );
        })}
      </div>
    </Content>
  );
};

// ── table:对照表,表头先到,行一条条滑上来,要强调的那一列描金 ──────────────
export const Table: React.FC<{ p: { title?: string; cols: string[]; rows: string[][]; hl?: number } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const u = stage.u;
  const cols = (p.cols || []).slice(0, 3);
  const nc = Math.max(1, cols.length);
  const rows = (p.rows || []).filter((r) => Array.isArray(r)).slice(0, 5);
  const w = stage.W - 120 * u;
  const cw = w / nc;
  const cell = Math.min(...rows.flatMap((r) => r.slice(0, nc).map((c) => fitBlock(String(c ?? ""), cw - 40 * u, 50 * u, 28 * u, 2).size)), 50 * u);
  const head = pop(f, 2, { damping: 16 }, 20);
  const ats = rows.map((_, i) => cueAt(ctx, i, rows.length, 12));
  const hl = Number.isFinite(p.hl) ? Number(p.hl) : nc - 1;
  return (
    <Content gap={40 * u}>
      <Kicker text={p.title} />
      <div style={{ width: w, borderRadius: 28 * u, overflow: "hidden", border: `${2 * u}px solid ${th.cardBorder}`, background: th.card }}>
        <div style={{ display: "flex", opacity: clamp01(head * 1.4), borderBottom: `${3 * u}px solid ${th.accent}` }}>
          {cols.map((c, i) => (
            <div key={i} style={{ width: cw, padding: `${36 * u}px ${20 * u}px`, textAlign: "center", fontFamily: th.sans, fontWeight: 800, fontSize: fitSize(c, cw - 40 * u, 54 * u, 28 * u), color: i === hl ? th.accentHi : th.sub, whiteSpace: "nowrap" }}>
              {c}
            </div>
          ))}
        </div>
        {rows.map((r, ri) => {
          const s = pop(f, ats[ri], { damping: 16, stiffness: 150 }, 22);
          return (
            <div key={ri} style={{ display: "flex", opacity: f < ats[ri] ? 0 : clamp01(s * 1.6), transform: `translateY(${(1 - s) * 30}px)`, borderBottom: ri < rows.length - 1 ? `${1 * u}px solid ${th.faint}` : "none" }}>
              {cols.map((_, ci) => {
                const blk = fitBlock(String(r[ci] ?? ""), cw - 40 * u, cell, cell, 2);
                return (
                  <div key={ci} style={{ width: cw, padding: `${34 * u}px ${20 * u}px`, textAlign: "center", background: ci === hl ? th.glow.replace(/[\d.]+\)$/, "0.10)") : "transparent" }}>
                    {blk.lines.map((l, k) => (
                      <div key={k} style={{ fontFamily: th.sans, fontSize: cell, lineHeight: 1.4, fontWeight: ci === 0 ? 700 : 500, color: ci === hl ? th.text : ci === 0 ? th.sub : th.muted }}>
                        {l}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Content>
  );
};
