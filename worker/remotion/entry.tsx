// Remotion 入口:只注册一个合成「Beat」(一拍 = 几个镜头),尺寸和时长都从参数里来
import React from "react";
import { Composition, registerRoot } from "remotion";
import { Beat, type BeatProps } from "../../shots/Shot";

const Root: React.FC = () => (
  <Composition
    id="Beat"
    component={Beat as React.FC<Record<string, unknown>>}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={90}
    defaultProps={{ W: 1080, H: 1920, shots: [], theme: "ink" } as unknown as Record<string, unknown>}
    calculateMetadata={({ props }) => {
      const p = props as unknown as BeatProps & { frames?: number };
      const end = Math.max(1, ...p.shots.map((s) => s.from + s.frames));
      return { width: p.W, height: p.H, durationInFrames: Math.max(1, p.frames ?? end) };
    }}
  />
);

registerRoot(Root);
