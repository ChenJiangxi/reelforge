"use client";

import { useState } from "react";

export type ClipThumb = { name: string; text: string; image?: string; dur?: number };

// Editor-style preview: latest cut on top, per-clip thumbnail strip below
// (click a clip to inspect its card). Falls back gracefully by what exists.
export function PreviewPane({
  video,
  clips,
  aspect,
  audio,
  wave,
}: {
  video?: string;
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
}) {
  const [inspect, setInspect] = useState<ClipThumb | null>(null);
  const vertical = aspect !== "16:9";
  const anyMedia = video || clips.some((c) => c.image);

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">预览</span>
        {video && (
          <button
            onClick={() => setInspect(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              inspect ? "border border-border text-muted-foreground" : "bg-foreground text-background"
            }`}
          >
            成片
          </button>
        )}
      </div>

      <div className="flex flex-1 items-center justify-center bg-muted/50 p-4">
        {!anyMedia && (
          <div className="py-16 text-center text-sm text-muted-foreground">
            还没有画面。
            <br />
            等「素材」阶段出卡、「剪辑」出片后,这里实时可预览。
          </div>
        )}
        {anyMedia && !inspect && video && (
          <video
            key={video}
            controls
            className={`rounded-md border border-border bg-black ${
              vertical ? "max-h-[62vh] w-auto" : "w-full"
            }`}
            src={video}
          />
        )}
        {anyMedia && (inspect || !video) && (
          <div className="flex max-w-full flex-col items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={inspect?.name ?? "card"}
              src={inspect?.image ?? clips.find((c) => c.image)?.image}
              className={`rounded-md border border-border ${vertical ? "max-h-[56vh] w-auto" : "w-full max-w-2xl"}`}
            />
            {inspect && (
              <div className="max-w-md text-center text-xs text-muted-foreground">
                {inspect.name} · {inspect.text}
              </div>
            )}
          </div>
        )}
      </div>

      {(clips.some((c) => c.image) || wave) && (
        <div className="space-y-2 border-t border-border p-3">
          {/* 画面轨 */}
          {clips.some((c) => c.image) && (
            <div className="flex items-stretch gap-2">
              <div className="flex w-10 shrink-0 flex-col items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground">
                画面
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {clips.map((c, i) => (
                  <button
                    key={c.name}
                    onClick={() => setInspect(c)}
                    className={`group relative shrink-0 overflow-hidden rounded-md border text-left ${
                      inspect?.name === c.name ? "border-accent" : "border-border hover:border-foreground/30"
                    }`}
                    title={c.text}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.image} alt={c.name} className={`w-auto object-cover ${vertical ? "h-24" : "h-20"}`} />
                    <span className="absolute left-1 top-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                      {i + 1}
                    </span>
                    {c.dur != null && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                        {c.dur.toFixed(1)}s
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* 配音轨 */}
          {wave && (
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground">
                配音
              </div>
              <button
                onClick={() => audio && new Audio(audio).play()}
                className="relative h-10 min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/60 text-left"
                title="点击播放配音"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={wave} alt="配音波形" className="h-full w-full object-fill opacity-90" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
