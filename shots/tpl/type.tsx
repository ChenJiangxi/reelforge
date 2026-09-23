// 文字类镜头:砸字钩子、推进问句、逐句落、金句、大单字
import React from "react";
import { Easing, interpolate } from "remotion";
import { Content, Chip, Kicker, clamp01, cueAt, fitBlock, fitSize, pop, ramp, textEm, useF, useShot } from "../kit";

/** 长句拆两行:优先在标点处断,否则从中间断 */
function splitTwo(s: string): string[] {
  const t = String(s ?? "").trim();
  if (textEm(t) <= 6.5) return [t];
  const chars = [...t];
  const mid = chars.length / 2;
  let best = -1;
  chars.forEach((c, i) => {
    if (/[，,、：:；;。！？!?\s]/.test(c) && i > 1 && i < chars.length - 2 && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  });
  if (best > 0) return [chars.slice(0, best + 1).join("").replace(/[，,、：:；;\s]$/, ""), chars.slice(best + 1).join("")];
  const cut = Math.ceil(mid);
  return [chars.slice(0, cut).join(""), chars.slice(cut).join("")];
}

// ── stomp:字一个个砸下来,落定后晕开暖光 ─────────────────────────
export const Stomp: React.FC<{ p: { small?: string; big: string } }> = ({ p }) => {
  const f = useF();
  const { th, stage } = useShot();
  const lines = splitTwo(p.big);
  const maxW = stage.W * 0.86;
  const size = Math.min(...lines.map((l) => fitSize(l, maxW, 210 * stage.u, 84 * stage.u, 0.04)));
  let idx = 0;
  const step = Math.max(2, Math.min(4, Math.floor(40 / Math.max(1, [...p.big].length))));
  const last = 6 + ([...lines.join("")].length - 1) * step;
  const halo = ramp(f, last + 4, last + 30);
  const small = ramp(f, 0, 12);
  const smallSize = fitSize(p.small || "", maxW, 66 * stage.u, 36 * stage.u, 0.1);
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity: halo,
          background: `radial-gradient(closest-side at 50% 44%, ${th.glow}, rgba(0,0,0,0) 72%)`,
        }}
      />
      <Content gap={30 * stage.u}>
        {p.small ? (
          <div style={{ fontFamily: th.sans, fontSize: smallSize, letterSpacing: smallSize * 0.1, color: th.muted, opacity: small, transform: `translateY(${(1 - small) * 12}px)` }}>
            {p.small}
          </div>
        ) : null}
        {lines.map((l, li) => (
          <div key={li} style={{ fontSize: 0, whiteSpace: "nowrap" }}>
            {[...l].map((c) => {
              const at = 6 + idx++ * step;
              const k = ramp(f, at, at + 7);
              return (
                <span
                  key={at}
                  style={{
                    display: "inline-block",
                    opacity: k,
                    transform: `scale(${2.3 - 1.3 * k})`,
                    fontFamily: th.sans,
                    fontWeight: 800,
                    fontSize: size,
                    letterSpacing: size * 0.04,
                    lineHeight: 1.18,
                    color: th.accentHi,
                    textShadow: `0 0 ${60 * stage.u}px ${th.glow}`,
                  }}
                >
                  {c}
                </span>
              );
            })}
          </div>
        ))}
        <div style={{ width: maxW * 0.22 * halo, height: 4 * stage.u, background: th.accent, borderRadius: 2, opacity: halo }} />
      </Content>
    </>
  );
};

// ── ask:一句小字先立住,大问句再落,整体缓缓推近 ─────────────────
export const Ask: React.FC<{ p: { a?: string; b: string } }> = ({ p }) => {
  const f = useF();
  const { th, stage, dur } = useShot();
  // 切进来就要有东西:小字立刻出,大问句 8 帧(约 0.27 秒)后落
  const s1 = pop(f, 0);
  const s2 = pop(f, p.a ? 8 : 2, { damping: 12, stiffness: 180 });
  const push = interpolate(f, [8, Math.max(20, dur - 1)], [1, 1.12], { easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const maxW = stage.W * 0.84;
  const b = fitBlock(p.b, maxW, 132 * stage.u, 70 * stage.u, 2);
  const aSize = fitSize(p.a || "", maxW, 70 * stage.u, 40 * stage.u);
  return (
    <Content gap={38 * stage.u} style={{ transform: `scale(${push})`, transformOrigin: "50% 46%" }}>
      {p.a ? (
        <div style={{ fontFamily: th.sans, fontSize: aSize, color: th.muted, opacity: clamp01(s1 * 1.5), transform: `translateY(${(1 - s1) * 20}px)` }}>{p.a}</div>
      ) : null}
      <div style={{ textAlign: "center", opacity: clamp01(s2 * 1.5), transform: `translateY(${(1 - s2) * 26}px)` }}>
        {b.lines.map((l, i) => (
          <div key={i} style={{ fontFamily: th.sans, fontWeight: 800, fontSize: b.size, lineHeight: 1.22, letterSpacing: b.size * 0.02, color: th.accentHi, textShadow: `0 0 ${56 * stage.u}px ${th.glow}` }}>
            {l}
          </div>
        ))}
      </div>
    </Content>
  );
};

// ── lines:2-4 句短话按念到的时刻逐句落下,新的一句落下时前面的压暗 ─────
export const Lines: React.FC<{ p: { kicker?: string; lines: string[]; accent?: number } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const lines = (p.lines || []).filter(Boolean).slice(0, 4);
  const accent = Number.isFinite(p.accent) ? Number(p.accent) : lines.length - 1;
  const maxW = stage.W * 0.84;
  const size = Math.min(...lines.map((l) => fitSize(l, maxW, 116 * stage.u, 56 * stage.u, 0.03)));
  const ats = lines.map((_, i) => cueAt(ctx, i, lines.length, 4));
  return (
    <Content gap={60 * stage.u}>
      <Kicker text={p.kicker} />
      {lines.map((l, i) => {
        const s = pop(f, ats[i], { damping: 14, stiffness: 170, mass: 0.8 }, 22);
        const next = i + 1 < lines.length ? ramp(f, ats[i + 1], ats[i + 1] + 10) : 0;
        const isAcc = i === accent;
        return (
          <div
            key={i}
            style={{
              fontFamily: th.sans,
              fontWeight: isAcc ? 800 : 700,
              fontSize: isAcc ? Math.round(size * 1.08) : size,
              letterSpacing: size * 0.03,
              color: isAcc ? th.accentHi : th.sub,
              opacity: f < ats[i] ? 0 : clamp01(s * 1.6) * (1 - 0.45 * next),
              transform: `translateY(${(1 - s) * 28}px)`,
              textShadow: isAcc ? `0 0 ${50 * stage.u}px ${th.glow}` : "none",
              whiteSpace: "nowrap",
            }}
          >
            {l}
          </div>
        );
      })}
    </Content>
  );
};

// ── quote:金句,宋体大字逐字浮现,重点词描金划线 ─────────────────
export const Quote: React.FC<{ p: { text: string; em?: string; by?: string } }> = ({ p }) => {
  const f = useF();
  const { th, stage, dur } = useShot();
  const maxW = stage.W * 0.8;
  const blk = fitBlock(p.text, maxW, 110 * stage.u, 60 * stage.u, 4);
  const total = [...blk.lines.join("")].length;
  const step = Math.max(0.6, Math.min(1.6, (dur * 0.35) / Math.max(1, total)));
  const mark = ramp(f, 2, 16);
  const emStart = p.em ? blk.lines.join("").indexOf(p.em) : -1;
  const emEnd = emStart >= 0 ? emStart + [...(p.em || "")].length : -1;
  const doneAt = 8 + total * step;
  const by = ramp(f, doneAt + 4, doneAt + 18);
  let idx = 0;
  return (
    <Content>
      <div style={{ position: "relative", width: maxW }}>
        <div style={{ position: "absolute", left: -20 * stage.u, top: -170 * stage.u, fontFamily: th.serif, fontSize: 260 * stage.u, lineHeight: 1, color: th.accent, opacity: 0.5 * mark }}>“</div>
        {blk.lines.map((l, li) => (
          <div key={li} style={{ fontFamily: th.serif, fontWeight: 700, fontSize: blk.size, lineHeight: 1.5, color: th.text, whiteSpace: "nowrap" }}>
            {[...l].map((c) => {
              const i = idx++;
              const k = ramp(f, 8 + i * step, 8 + i * step + 8);
              const isEm = i >= emStart && i < emEnd;
              return (
                <span key={i} style={{ display: "inline-block", opacity: k, transform: `translateY(${(1 - k) * 14}px)`, color: isEm ? th.accentHi : undefined, textShadow: isEm ? `0 0 ${30 * stage.u}px ${th.glow}` : undefined }}>
                  {c}
                </span>
              );
            })}
          </div>
        ))}
        {p.by ? (
          <div style={{ marginTop: 40 * stage.u, textAlign: "right", fontFamily: th.sans, fontSize: 38 * stage.u, color: th.muted, opacity: by, letterSpacing: 4 }}>—— {p.by}</div>
        ) : null}
      </div>
    </Content>
  );
};

// ── glyph:一个字讲完一件事(合 / 冲 / 偏),下面挂术语和原话 ─────────
export const Glyph: React.FC<{ p: { glyph: string; label?: string; chips?: string[]; note?: string; tone?: "main" | "alt" } }> = ({ p }) => {
  const f = useF();
  const ctx = useShot();
  const { th, stage } = ctx;
  const color = p.tone === "alt" ? th.accent2 : th.accentHi;
  const glow = p.tone === "alt" ? th.glow2 : th.glow;
  const g = [...String(p.glyph || "")].slice(0, 2).join("");
  const size = (g.length > 1 ? 270 : 360) * stage.u;
  const big = pop(f, 2, { damping: 13, stiffness: 150 }, 26);
  const chips = (p.chips || []).filter(Boolean).slice(0, 3);
  const chipAt = Number.isFinite(ctx.cues[0]) ? ctx.cues[0] : 16;
  const noteAt = Number.isFinite(ctx.cues[1]) ? ctx.cues[1] : chipAt + 24;
  const q = pop(f, Math.max(noteAt, chipAt + 14), { damping: 16 });
  const noteBlk = fitBlock(p.note || "", stage.W * 0.8, 50 * stage.u, 34 * stage.u, 2);
  return (
    <>
      <div style={{ position: "absolute", inset: 0, opacity: clamp01(big), background: `radial-gradient(closest-side at 50% 38%, ${glow}, rgba(0,0,0,0) 70%)` }} />
      <Content gap={30 * stage.u}>
        <div style={{ fontFamily: th.serif, fontSize: size, lineHeight: 1, color, opacity: clamp01(big * 1.4), transform: `scale(${0.72 + 0.28 * big})`, textShadow: `0 0 ${90 * stage.u}px ${glow}`, whiteSpace: "nowrap" }}>
          {g}
        </div>
        {p.label ? (
          <div style={{ fontFamily: th.sans, fontSize: 46 * stage.u, letterSpacing: 14 * stage.u, paddingLeft: 14 * stage.u, color, opacity: clamp01(big) }}>{p.label}</div>
        ) : null}
        {chips.length ? (
          <div style={{ display: "flex", gap: 18 * stage.u, marginTop: 8 * stage.u }}>
            {chips.map((c, i) => (
              <Chip key={i} text={c} k={pop(f, chipAt + i * 6, { damping: 15, stiffness: 170 }, 20)} color={color} size={42 * stage.u} />
            ))}
          </div>
        ) : null}
        {p.note ? (
          <div style={{ marginTop: 26 * stage.u, textAlign: "center", opacity: clamp01(q * 1.4), transform: `translateY(${(1 - q) * 14}px)` }}>
            {noteBlk.lines.map((l, i) => (
              <div key={i} style={{ fontFamily: th.sans, fontSize: noteBlk.size, lineHeight: 1.5, color: th.sub }}>
                {l}
              </div>
            ))}
          </div>
        ) : null}
      </Content>
    </>
  );
};
