// 画面镜头:一张 AI 生成的图(人物、场景、意象)铺满全屏,镜头缓慢运动,关键词压在图上。
// 让片子不再全是字 —— 讲情绪、场景、比喻的地方给画面,讲结构、数字的地方才给图表。
import React from "react";
import { Easing, Img, interpolate } from "remotion";
import { clamp01, fitBlock, pop, ramp, useF, useShot } from "../kit";

type P = {
  /** 生图用的画面描述(不上屏) */
  prompt?: string;
  /** 图的地址:网页上是媒体地址,渲染机上是 data URL */
  src?: string;
  kicker?: string;
  big?: string;
  /** 镜头怎么动 */
  motion?: "push" | "pull" | "left" | "right" | "up";
  /** 字放哪:上方三分之一(默认)或画面中间 */
  place?: "top" | "center";
};

export const Scene: React.FC<{ p: P }> = ({ p }) => {
  const f = useF();
  const { th, stage, dur, cues } = useShot();
  const t = interpolate(f, [0, Math.max(1, dur - 1)], [0, 1], { easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const m = p.motion ?? "push";
  const scale = m === "pull" ? 1.14 - 0.1 * t : m === "push" ? 1.04 + 0.1 * t : 1.12;
  const dx = m === "left" ? (0.5 - t) * 6 : m === "right" ? (t - 0.5) * 6 : 0;
  const dy = m === "up" ? (0.5 - t) * 6 : 0;
  const fadeIn = ramp(f, 0, 8);
  const at = Number.isFinite(cues[0]) ? cues[0] : 6;
  const k = pop(f, at, { damping: 16, stiffness: 140 }, 26);
  const u = stage.u;
  const big = p.big ? fitBlock(p.big, stage.W * 0.84, 118 * u, 64 * u, 2) : null;
  const top = (p.place ?? "top") === "top";
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000", overflow: "hidden" }}>
      {p.src ? (
        <Img
          src={p.src}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: fadeIn,
            transform: `translate(${dx}%, ${dy}%) scale(${scale})`,
            transformOrigin: "50% 45%",
          }}
        />
      ) : (
        <div style={{ position: "absolute", inset: 0, background: th.bg }} />
      )}
      {/* 上下压暗:上面托住字,下面托住字幕 */}
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, rgba(0,0,0,${top && big ? 0.55 : 0.2}) 0%, rgba(0,0,0,0) 34%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.62) 100%)` }} />
      {big || p.kicker ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: top ? stage.top + 20 * u : undefined,
            bottom: top ? undefined : stage.bottom + (stage.H - stage.top - stage.bottom) * 0.38,
            padding: `0 ${72 * u}px`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 18 * u,
            opacity: clamp01(k * 1.4),
            transform: `translateY(${(1 - k) * 24}px)`,
          }}
        >
          {p.kicker ? (
            <div style={{ fontFamily: th.sans, fontSize: 38 * u, letterSpacing: 12 * u, paddingLeft: 12 * u, color: "rgba(255,255,255,0.78)", textShadow: "0 2px 12px rgba(0,0,0,0.7)" }}>{p.kicker}</div>
          ) : null}
          {big
            ? big.lines.map((l, i) => (
                <div key={i} style={{ fontFamily: th.sans, fontWeight: 800, fontSize: big.size, lineHeight: 1.2, color: th.id === "paper" ? "#FFF6EA" : th.accentHi, textAlign: "center", textShadow: "0 4px 30px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)", whiteSpace: "nowrap" }}>
                  {l}
                </div>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
};
