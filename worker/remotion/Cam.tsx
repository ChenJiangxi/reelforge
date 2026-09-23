// 素材推镜:输入是 ffmpeg 已经按时长和进画规则处理好的 W×H 片段(录屏、图片、老动画卡),
// 这里只负责镜头:关键帧之间 easeInOutCubic 平滑过渡,CSS 变换是亚像素的 ——
// 原来用 ffmpeg zoompan,每帧按整像素取整,细字会抖(她:「不要抖,静止就可以了,或者调用 shotcraft 做动画」)。
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, Easing, interpolate } from "remotion";

export type CamKey = { f: number; z: number; cx: number; cy: number };
export type CamProps = { src: string; kind: "video" | "image"; W: number; H: number; frames: number; keys: CamKey[] };

const ease = Easing.inOut(Easing.cubic);

function at(keys: CamKey[], f: number): CamKey {
  if (!keys.length) return { f, z: 1, cx: 0.5, cy: 0.5 };
  if (f <= keys[0].f) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (f <= b.f) {
      const t = ease(interpolate(f, [a.f, Math.max(a.f + 1, b.f)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
      return { f, z: a.z + (b.z - a.z) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
    }
  }
  return keys[keys.length - 1];
}

export const Cam: React.FC<CamProps> = ({ src, kind, W, H, keys }) => {
  const f = useCurrentFrame();
  const k = at(keys, f);
  const z = Math.max(1, k.z);
  // cx/cy 是画面里要居中的点(0-1);推完画面边缘不许露出来
  const tx = Math.min(0, Math.max(W - W * z, W / 2 - k.cx * W * z));
  const ty = Math.min(0, Math.max(H - H * z, H / 2 - k.cy * H * z));
  const style: React.CSSProperties = { position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${z})` };
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      {kind === "video" ? <OffthreadVideo src={staticFile(src)} muted style={style} /> : <Img src={staticFile(src)} style={style} />}
    </AbsoluteFill>
  );
};
