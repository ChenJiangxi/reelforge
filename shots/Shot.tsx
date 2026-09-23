// 一个镜头 / 一拍(几个镜头按时间排开)。网页预览和渲染机共用。
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, Video, getRemotionEnvironment, interpolate, Easing, useCurrentFrame } from "remotion";
import { ShotProvider, stageOf, type ShotCtx } from "./kit";
import { themeOf } from "./theme";
import { TEMPLATES } from "./registry";

export type ShotSpec = {
  tpl: string;
  /** 素材镜头(只有网页预览用;渲染机上素材镜头走 ffmpeg 的进画规则) */
  asset?: { src: string; kind: string };
  p: Record<string, unknown>;
  /** 相对这一拍开头的起始帧 */
  from: number;
  frames: number;
  /** 镜头内各元素出现的帧(相对镜头开头) */
  cues?: number[];
};

export type BeatProps = {
  theme?: string;
  W: number;
  H: number;
  shots: ShotSpec[];
};

/** 背景:暗角渐变 + 一团慢慢挪动的光,保证整段画面始终在动(不会被死帧质检抓到) */
const Backdrop: React.FC<{ th: ReturnType<typeof themeOf>; dur: number; seed: number }> = ({ th, dur, seed }) => {
  const f = useCurrentFrame();
  const t = dur > 1 ? f / (dur - 1) : 0;
  const x = 50 + Math.sin(seed * 1.7 + t * 1.6) * 16;
  const y = 36 + Math.cos(seed * 2.3 + t * 1.2) * 10;
  return (
    <>
      <AbsoluteFill style={{ background: th.base }} />
      <AbsoluteFill style={{ background: th.bg }} />
      <AbsoluteFill style={{ background: `radial-gradient(40% 28% at ${x}% ${y}%, ${th.glow.replace(/[\d.]+\)$/, "0.10)")}, rgba(0,0,0,0) 100%)` }} />
    </>
  );
};

/** 素材镜头的预览:整幅放进画面,背后垫一层它自己的模糊放大版(和渲染机的进画规则同一个意思) */
const AssetFrame: React.FC<{ src: string; kind: string }> = ({ src, kind }) => {
  const isVideo = kind === "video";
  const V = getRemotionEnvironment().isRendering ? OffthreadVideo : Video;
  const media = (style: React.CSSProperties) =>
    isVideo ? <V src={src} muted style={style} /> : <Img src={src} style={style} />;
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <AbsoluteFill style={{ filter: "blur(40px) brightness(0.55)", transform: "scale(1.2)" }}>{media({ width: "100%", height: "100%", objectFit: "cover" })}</AbsoluteFill>
      <AbsoluteFill>{media({ width: "100%", height: "100%", objectFit: "contain" })}</AbsoluteFill>
    </AbsoluteFill>
  );
};

export const OneShot: React.FC<{ spec: ShotSpec; theme?: string; W: number; H: number; seed?: number }> = ({ spec, theme, W, H, seed = 0 }) => {
  const f = useCurrentFrame();
  if (spec.asset) return <AssetFrame src={spec.asset.src} kind={spec.asset.kind} />;
  const th = themeOf(theme);
  const stage = stageOf(W, H);
  const T = TEMPLATES[spec.tpl] || TEMPLATES.lines;
  const ctx: ShotCtx = { stage, th, dur: spec.frames, cues: spec.cues || [] };
  // 整个镜头很慢地推近 3%:入场动画演完之后画面也不是死的
  const push = interpolate(f, [0, Math.max(1, spec.frames - 1)], [1, 1.03], { easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <ShotProvider value={ctx}>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Backdrop th={th} dur={spec.frames} seed={seed} />
        <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: "50% 45%" }}>
          <T p={spec.p as never} />
        </AbsoluteFill>
      </AbsoluteFill>
    </ShotProvider>
  );
};

export const Beat: React.FC<BeatProps> = ({ theme, W, H, shots }) => {
  return (
    <AbsoluteFill style={{ background: themeOf(theme).base }}>
      {shots.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={Math.max(1, s.frames)} layout="none">
          <OneShot spec={s} theme={theme} W={W} H={H} seed={i + 1} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
