// 镜头模板共用的小工具:画布尺寸、配色、出现时刻、字号估算。
// 网页预览(@remotion/player)和渲染机(@remotion/renderer)用的是同一份代码,
// 所以这里不许读 DOM 量字宽 —— 两边字体不一定一样,量出来会不一样。字宽按字符种类估。
import React, { createContext, useContext } from "react";
import { interpolate, spring, useCurrentFrame, Easing } from "remotion";
import type { Theme } from "./theme";

export const FPS = 30;

export type Stage = {
  W: number;
  H: number;
  portrait: boolean;
  /** 内容区:竖屏下面留 32%(字幕在 72% 处,再往下是抖音的按钮区) */
  top: number;
  bottom: number;
  /** 尺寸单位:9:16 下是 1,其它画幅按内容区缩放 */
  u: number;
};

export type ShotCtx = {
  stage: Stage;
  th: Theme;
  /** 这个镜头多少帧 */
  dur: number;
  /** 第 k 个元素什么时候出现(帧,相对镜头开头)。没给就在镜头前 55% 里均匀排开 */
  cues: number[];
};

const Ctx = createContext<ShotCtx | null>(null);
export const ShotProvider = Ctx.Provider;
export function useShot(): ShotCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("镜头模板必须包在 <Shot> 里");
  return c;
}

export function stageOf(W: number, H: number): Stage {
  const portrait = H >= W;
  // 字幕位置照 ops-bilibili(她定的):9:16 在 y≈0.72(抖音底部 20% 被按钮和文案盖着),3:4 在 0.79 往下,横屏 0.87。
  // 内容区停在字幕上面
  const ratio = H / W;
  const top = Math.round(H * (ratio > 1.6 ? 0.08 : portrait ? 0.07 : 0.08));
  const bottom = Math.round(H * (ratio > 1.6 ? 0.32 : portrait ? 0.24 : 0.18));
  const contentH = H - top - bottom;
  const u = portrait ? Math.min(W / 1080, contentH / 1160) : Math.min(W / 1920, contentH / 800) * 0.9;
  return { W, H, portrait, top, bottom, u };
}

/** 第 k 个(共 n 个)元素出现的帧 */
export function cueAt(ctx: ShotCtx, k: number, n: number, first = 6): number {
  const c = ctx.cues[k];
  if (Number.isFinite(c)) return Math.max(0, Math.round(c));
  if (n <= 1) return first;
  const span = Math.max(12, ctx.dur * 0.55 - first);
  return Math.round(first + (span * k) / (n - 1));
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function ramp(f: number, a: number, b: number, ease: (t: number) => number = Easing.out(Easing.cubic)) {
  return interpolate(f, [a, b], [0, 1], { easing: ease, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

export function pop(f: number, at: number, cfg: { damping?: number; stiffness?: number; mass?: number } = {}, len = 24) {
  return spring({ frame: f - at, fps: FPS, config: { damping: 15, stiffness: 160, mass: 0.9, ...cfg }, durationInFrames: len });
}

export function useF() {
  return useCurrentFrame();
}

// ── 字宽估算 ──────────────────────────────────────────────
// 汉字/全角 1em,数字 0.6em,拉丁字母 0.56em,半角标点 0.35em,空格 0.3em
export function textEm(s: string, letterSpacingEm = 0): number {
  let w = 0;
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) || 0;
    if (ch === " ") w += 0.3;
    else if (c >= 0x2e80) w += 1;
    else if (/[0-9]/.test(ch)) w += 0.6;
    else if (/[A-Za-z]/.test(ch)) w += 0.56;
    else w += 0.35;
    w += letterSpacingEm;
  }
  return w;
}

/** 一行放进 maxW 像素的最大字号(不超过 max,不小于 min) */
export function fitSize(s: string, maxW: number, max: number, min = 24, letterSpacingEm = 0): number {
  const em = textEm(s, letterSpacingEm);
  if (!em) return max;
  return Math.max(min, Math.min(max, Math.floor(maxW / em)));
}

/** 按宽度折行(中文按字断,英文按词断),返回行数组 */
export function wrap(s: string, maxW: number, size: number): string[] {
  const out: string[] = [];
  let line = "";
  const tokens = String(s ?? "").match(/[A-Za-z0-9.%+\-]+|\s+|./gu) || [];
  for (const t of tokens) {
    const next = line + t;
    if (line && textEm(next) * size > maxW) {
      out.push(line.trim());
      line = t.trimStart();
    } else line = next;
  }
  if (line.trim()) out.push(line.trim());
  // 标点不许打头:挪到上一行末尾
  for (let i = 1; i < out.length; i++) {
    const m = out[i].match(/^[，。、；：！？,.;:!?」』)》”]+/u);
    if (m) {
      out[i - 1] += m[0];
      out[i] = out[i].slice(m[0].length);
    }
  }
  return out.filter(Boolean);
}

/** 让一段字在 maxLines 行内放进 maxW:返回字号和折好的行。
 *  折成多行时把行宽收窄到"行数不变的最窄宽度",各行长短接近,不会剩一个孤字挂在最后一行 */
/** 按标点切成短语,再把短语贪心地并成行;某个短语本身放不下就返回 null */
function phraseLines(s: string, maxW: number, size: number): string[] | null {
  const parts = String(s ?? "").match(/[^，,、；;：:。！？!?]+[，,、；;：:。！？!?]*/gu) || [];
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const ph of parts) {
    const t = ph.trim();
    if (textEm(t) * size > maxW) return null;
    const last = out[out.length - 1];
    if (last != null && textEm(last + t) * size <= maxW) out[out.length - 1] = last + t;
    else out.push(t);
  }
  return out;
}

export function fitBlock(s: string, maxW: number, max: number, min: number, maxLines: number) {
  const byChars = fitBlockChars(s, maxW, max, min, maxLines);
  // 能在标点处断就在标点处断(读起来是整句),只要字号不比按字断小太多
  if (byChars.lines.length > 1) {
    for (let sz = max; sz >= Math.max(min, byChars.size * 0.72); sz -= 2) {
      const l = phraseLines(s, maxW, sz);
      if (l && l.length <= maxLines) return { size: sz, lines: l };
    }
  }
  return byChars;
}

function fitBlockChars(s: string, maxW: number, max: number, min: number, maxLines: number) {
  let size = min;
  let lines = wrap(s, maxW, min);
  for (let sz = max; sz >= min; sz -= 2) {
    const l = wrap(s, maxW, sz);
    if (l.length <= maxLines) {
      size = sz;
      lines = l;
      break;
    }
  }
  if (lines.length > 1) {
    let lo = maxW * 0.4;
    let hi = maxW;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (wrap(s, mid, size).length <= lines.length) hi = mid;
      else lo = mid;
    }
    lines = wrap(s, hi, size);
  }
  return { size, lines };
}

// ── 通用小件 ──────────────────────────────────────────────

/** 顶部小标签(字距拉开的一行小字) */
export const Kicker: React.FC<{ text?: string; at?: number; color?: string }> = ({ text, at = 2, color }) => {
  const f = useF();
  const { th, stage } = useShot();
  if (!text) return null;
  const k = ramp(f, at, at + 14);
  const size = Math.round(38 * stage.u);
  return (
    <div
      style={{
        fontFamily: th.sans,
        fontSize: size,
        letterSpacing: size * 0.32,
        color: color ?? th.accentDim,
        opacity: k,
        transform: `translateY(${(1 - k) * 10}px)`,
        textAlign: "center",
        whiteSpace: "nowrap",
        paddingLeft: size * 0.32,
      }}
    >
      {text}
    </div>
  );
};

/** 内容区:上下留出字幕带,居中摆放 */
export const Content: React.FC<{ children: React.ReactNode; gap?: number; justify?: React.CSSProperties["justifyContent"]; pad?: number; style?: React.CSSProperties }> = ({
  children,
  gap = 0,
  justify = "center",
  pad,
  style,
}) => {
  const { stage } = useShot();
  const px = pad ?? Math.round((stage.portrait ? 72 : 140) * (stage.portrait ? stage.W / 1080 : stage.W / 1920));
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: stage.top,
        bottom: stage.bottom,
        padding: `0 ${px}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: justify,
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Chip: React.FC<{ text: string; k: number; color: string; filled?: boolean; size: number }> = ({ text, k, color, filled, size }) => {
  const { th } = useShot();
  return (
    <div
      style={{
        opacity: clamp01(k * 1.5),
        transform: `translateY(${(1 - k) * 16}px)`,
        fontFamily: th.sans,
        fontSize: size,
        padding: `${size * 0.26}px ${size * 0.72}px`,
        borderRadius: 999,
        color: filled ? th.onAccent : color,
        background: filled ? color : "transparent",
        border: `${Math.max(2, size * 0.05)}px solid ${color}`,
        whiteSpace: "nowrap",
        fontWeight: filled ? 700 : 500,
      }}
    >
      {text}
    </div>
  );
};

/** 数字部分拆出来:"89分" → {num: 89, pre: "", post: "分", decimals: 0} */
export function splitNumber(v: string | number) {
  const s = String(v ?? "");
  const m = s.match(/^(\D*?)(-?\d+(?:\.\d+)?)(.*)$/);
  if (!m) return null;
  const num = Number(m[2]);
  const decimals = (m[2].split(".")[1] || "").length;
  return { pre: m[1], num, post: m[3], decimals, raw: m[2] };
}
