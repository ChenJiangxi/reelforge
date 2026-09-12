"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type Artifacts } from "@/lib/stages";

export type ClipThumb = { name: string; text: string; image?: string; dur?: number };
export type ReviewTarget = { stageId: string; kind: string; artifacts: Artifacts };

// Editor-style preview: latest cut on top, per-clip tracks below.
// When a stage awaits review, the pane switches to REVIEW MODE — the artifact
// takes over the main view with the gate bar under it (审核是主角,不埋页尾).
export function PreviewPane({
  video,
  clips,
  aspect,
  audio,
  wave,
  review,
  working,
}: {
  video?: string;
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
  review?: ReviewTarget | null;
  working?: { kind: string; reason?: string | null } | null;
}) {
  const [inspect, setInspect] = useState<ClipThumb | null>(null);
  const [showCut, setShowCut] = useState(false);
  const vertical = aspect !== "16:9";
  const reviewing = !!review && !showCut;
  const anyMedia = video || clips.some((c) => c.image);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">
          {reviewing ? `审核:${stageLabel(review.kind)}` : "预览"}
        </span>
        <div className="flex items-center gap-2">
          {reviewing && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <span className="inline-block size-1.5 rounded-full bg-accent" />
              待你审
            </span>
          )}
          {review && video && (
            <button
              onClick={() => setShowCut((v) => !v)}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-foreground/30"
            >
              {showCut ? `回到审核` : "看成片"}
            </button>
          )}
        </div>
      </div>

      {reviewing ? (
        <ReviewBody kind={review.kind} artifacts={review.artifacts} stageId={review.stageId} vertical={vertical} />
      ) : (
        <>
          {working && (
            <div className="flex items-center gap-2 border-b border-border bg-muted/70 px-4 py-2 text-xs">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" />
              <span className="text-muted-foreground">
                正在做「{stageLabel(working.kind)}」
                {working.reason ? <>,因为你:<span className="text-foreground/80">{working.reason.slice(0, 40)}{working.reason.length > 40 ? "…" : ""}</span></> : null}
                — 旧版先看着,好了自动切审核
              </span>
            </div>
          )}
          <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/50 p-4">
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
                className={`rounded-md border border-border bg-black ${vertical ? "max-h-[62vh] w-auto" : "w-full"}`}
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
        </>
      )}
    </div>
  );
}

// ── review mode: the artifact fills the pane, the gate sits under it ──

function ReviewBody({
  kind,
  artifacts,
  stageId,
  vertical,
}: {
  kind: string;
  artifacts: Artifacts;
  stageId: string;
  vertical: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  async function resolve(decision: "approve" | "reject") {
    if (decision === "reject" && !note.trim()) {
      setErr("打回要写一句原因,agent 照着改");
      return;
    }
    setErr("");
    setBusy(true);
    await fetch("/api/stage/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId, decision, text: note.trim() || undefined }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/50 p-4">
        {/* 选题:角度+钩子+不吹 */}
        {kind === "topic" && (
          <pre className="mx-auto max-w-2xl whitespace-pre-wrap rounded-md bg-card p-5 text-sm leading-relaxed text-foreground/85">
            {artifacts.note}
          </pre>
        )}

        {/* 脚本:整篇口播稿 */}
        {kind === "script" && (
          <pre className="mx-auto max-w-2xl whitespace-pre-wrap rounded-md bg-card p-5 text-sm leading-relaxed text-foreground/85">
            {artifacts.script}
          </pre>
        )}

        {/* 素材:卡阵 */}
        {kind === "footage" && artifacts.images && (
          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3">
            {artifacts.images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} alt={`卡 ${i + 1}`} src={src} className="w-full rounded-md border border-border" />
            ))}
          </div>
        )}

        {/* 配音:播放器+波形 */}
        {kind === "voice" && (
          <div className="mx-auto flex max-w-xl flex-col items-center gap-4 rounded-md bg-card p-6">
            {artifacts.wave && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artifacts.wave} alt="波形" className="w-full rounded border border-border" />
            )}
            {artifacts.audio && <audio controls className="w-full" src={artifacts.audio} autoPlay />}
          </div>
        )}

        {/* 剪辑/字幕/润色:看视频 */}
        {(kind === "edit" || kind === "subtitles" || kind === "polish") && artifacts.video && (
          <div className="flex h-full items-center justify-center">
            <video
              key={artifacts.video}
              controls
              autoPlay
              className={`rounded-md border border-border bg-black ${vertical ? "max-h-[58vh] w-auto" : "w-full max-w-3xl"}`}
              src={artifacts.video}
            />
          </div>
        )}

        {/* 交付:封面+文案 */}
        {kind === "deliver" && (
          <div className="mx-auto flex max-w-2xl flex-wrap items-start justify-center gap-4">
            {artifacts.cover && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artifacts.cover} alt="封面" className="w-44 rounded-md border border-border" />
            )}
            {artifacts.caption && (
              <div className="min-w-56 flex-1 rounded-md bg-card p-4 text-sm">
                <div className="font-medium">{artifacts.caption.title}</div>
                <div className="mt-1 text-accent">{artifacts.caption.hashtags.join(" ")}</div>
                <div className="mt-1 text-muted-foreground">{artifacts.caption.desc}</div>
              </div>
            )}
          </div>
        )}

        {artifacts.note && !artifacts.note.startsWith("FAILED:") && (
          <p className="mx-auto mt-3 max-w-2xl text-center text-xs text-muted-foreground">{artifacts.note}</p>
        )}
      </div>

      {/* gate bar */}
      <div className="border-t border-accent/25 bg-accent-soft/50 p-3">
        {rejecting && (
          <div className="mb-2">
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="打回原因(指到具体某句/某卡),agent 照着改…"
              rows={2}
              className="w-full rounded-md border border-border bg-card p-2 text-sm outline-none focus:border-accent/60"
            />
          </div>
        )}
        {err && <div className="mb-2 text-xs text-destructive">{err}</div>}
        <div className="flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => resolve("approve")}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
          >
            通过,继续往下
          </button>
          {!rejecting ? (
            <button
              disabled={busy}
              onClick={() => setRejecting(true)}
              className="rounded-full bg-destructive/10 px-4 py-2 text-sm text-destructive hover:bg-destructive/15 disabled:opacity-40"
            >
              打回
            </button>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() => resolve("reject")}
                className="rounded-full bg-destructive px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
              >
                确认打回
              </button>
              <button
                onClick={() => {
                  setRejecting(false);
                  setNote("");
                  setErr("");
                }}
                className="rounded-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                算了
              </button>
            </>
          )}
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
            通过后 agent 自动做下一阶段
          </span>
        </div>
      </div>
    </>
  );
}
