"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type Artifacts, type Comment } from "@/lib/stages";

export type ClipThumb = { name: string; text: string; image?: string; dur?: number };
export type StageView = {
  id: string;
  kind: string;
  order: number;
  status: string;
  artifacts: Artifacts;
  comments: Comment[];
};

// 预览区 = 阶段查看器:进度条点哪段,这里就看哪段。
// 默认视图:待审 > 最新成片 > 制作中占位。审核门只在待审阶段出现。
export function PreviewPane({
  stages,
  clips,
  aspect,
  audio,
  wave,
  selectedId,
  onSelect,
  projectId,
}: {
  stages: StageView[];
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  projectId: string;
}) {
  const vertical = aspect !== "16:9";
  const awaiting = stages.find((s) => s.status === "awaiting_review");
  const withVideo = [...stages].reverse().find((s) => s.artifacts.video);
  const working = stages.find((s) => s.status === "working");

  const view: StageView | null =
    stages.find((s) => s.id === selectedId) ?? awaiting ?? withVideo ?? working ?? stages[0] ?? null;
  const isAwaiting = view?.status === "awaiting_review";
  const showingCut = view != null && withVideo != null && view.id === withVideo.id;
  const showTracks = showingCut || (view && ["edit", "subtitles", "polish"].includes(view.kind));

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
        还没有内容
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card shadow-xs">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <span className="text-[15px] font-semibold">{stageLabel(view.kind)}</span>
        <div className="flex items-center gap-2">
          {isAwaiting && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <span className="inline-block size-1.5 rounded-full bg-accent" />
              待你审
            </span>
          )}
          {view.status === "working" && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-accent" />
              制作中
            </span>
          )}
          {withVideo && !showingCut && (
            <button
              onClick={() => onSelect(withVideo.id)}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-foreground/30"
            >
              看成片
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/50 p-6">
        <StageArtifact stage={view} vertical={vertical} clips={clips} audio={audio} wave={wave} projectId={projectId} />
      </div>

      {showTracks && (
        <Tracks clips={clips} wave={wave} audio={audio} vertical={vertical} onSelect={undefined} />
      )}

      {isAwaiting && <GateBar stageId={view.id} onDone={() => onSelect(null)} />}
    </div>
  );
}

// ── artifact renderer, by stage kind ──

function StageArtifact({
  stage,
  vertical,
  clips,
  audio,
  wave,
  projectId,
}: {
  stage: StageView;
  vertical: boolean;
  clips: ClipThumb[];
  audio?: string;
  wave?: string;
  projectId: string;
}) {
  const a = stage.artifacts;

  if (stage.status === "pending") {
    return (
      <div className="flex h-full items-center justify-center py-16 text-center text-sm text-muted-foreground">
        这个阶段还没做。
        <br />
        上游通过后 agent 才动手。
      </div>
    );
  }
  if (stage.status === "working") {
    return (
      <div className="flex h-full items-center justify-center py-16 text-center text-sm text-muted-foreground">
        <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-accent" />
        agent 正在做「{stageLabel(stage.kind)}」…
      </div>
    );
  }

  const commentsBlock = stage.comments.length > 0 && (
    <div className="mx-auto mt-4 max-w-2xl space-y-1 text-xs text-muted-foreground">
      {stage.comments.map((c, i) => (
        <div key={i}>
          💬 {c.text} <span className="text-muted-foreground/50">({c.decision})</span>
        </div>
      ))}
    </div>
  );

  let body: React.ReactNode = null;
  if (stage.kind === "topic") {
    body = (
      <pre className="mx-auto max-w-2xl whitespace-pre-wrap rounded-lg bg-card p-8 text-[15px] leading-[1.9] text-foreground/85">
        {a.note}
      </pre>
    );
  } else if (stage.kind === "script") {
    body = <ScriptEditor stage={stage} projectId={projectId} />;
  } else if (stage.kind === "footage" && a.images?.length) {
    body = (
      <div className="mx-auto grid max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3">
        {a.images.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} alt={`卡 ${i + 1}`} src={src} className="w-full rounded-md border border-border" />
        ))}
      </div>
    );
  } else if (stage.kind === "voice") {
    body = (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-5 rounded-lg bg-card p-8">
        {(a.wave || wave) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.wave ?? wave} alt="波形" className="w-full rounded border border-border" />
        )}
        {(a.audio || audio) && <audio controls className="w-full" src={a.audio ?? audio} autoPlay />}
      </div>
    );
  } else if (a.video) {
    body = (
      <div className="flex h-full items-center justify-center">
        <video
          key={a.video}
          controls
          autoPlay={stage.status === "awaiting_review"}
          className={`rounded-md border border-border bg-black ${vertical ? "max-h-[58vh] w-auto" : "w-full max-w-3xl"}`}
          src={a.video}
        />
      </div>
    );
  } else if (stage.kind === "deliver") {
    body = (
      <div className="mx-auto flex max-w-2xl flex-wrap items-start justify-center gap-4">
        {a.cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.cover} alt="封面" className="w-52 rounded-lg border border-border" />
        )}
        {a.caption && (
          <div className="min-w-56 flex-1 rounded-lg bg-card p-5 text-[15px]">
            <div className="font-medium">{a.caption.title}</div>
            <div className="mt-1 text-accent">{a.caption.hashtags.join(" ")}</div>
            <div className="mt-1 text-muted-foreground">{a.caption.desc}</div>
          </div>
        )}
      </div>
    );
  } else if (a.note) {
    body = (
      <p className={`mx-auto max-w-2xl whitespace-pre-wrap text-sm ${a.note.startsWith("FAILED:") ? "text-destructive" : "text-muted-foreground"}`}>
        {a.note}
      </p>
    );
  }

  return (
    <>
      {body}
      {a.note && !a.note.startsWith("FAILED:") && (stage.kind !== "topic" && stage.kind !== "script") && (
        <p className="mx-auto mt-3 max-w-2xl text-center text-xs text-muted-foreground">{a.note}</p>
      )}
      {commentsBlock}
    </>
  );
}

// ── 脚本就地编辑:改文字就剪视频。编辑即通过(她的版本就是定稿)。──

function ScriptEditor({ stage, projectId }: { stage: StageView; projectId: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const text = stage.artifacts.script || stage.artifacts.note || "";

  async function save() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const r = await fetch(`/api/project/${projectId}/script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ narration: draft }),
    });
    setBusy(false);
    if (r.ok) {
      setEditing(false);
      router.refresh();
    }
  }

  if (!editing) {
    return (
      <div className="group relative mx-auto max-w-2xl">
        <pre className="whitespace-pre-wrap rounded-lg bg-card p-8 text-[15px] leading-[1.9] text-foreground/85">
          {text}
        </pre>
        <button
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
          className="absolute right-3 top-3 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground opacity-0 shadow-xs transition group-hover:opacity-100 hover:border-foreground/30 hover:text-foreground"
        >
          ✎ 直接改
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(24, Math.max(10, draft.split("\n").length + 2))}
        className="w-full resize-none rounded-lg border border-accent/50 bg-card p-6 text-[15px] leading-[1.9] outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={save}
          disabled={busy || !draft.trim()}
          className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
        >
          {busy ? "定稿中…" : "存稿,重出下游"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          取消
        </button>
        <span className="ml-auto text-xs text-muted-foreground">你的版本就是定稿,配音/画面/剪辑自动跟着重出</span>
      </div>
    </div>
  );
}

// ── tracks (cut view only) ──

function Tracks({
  clips,
  wave,
  audio,
  vertical,
}: {
  clips: ClipThumb[];
  wave?: string;
  audio?: string;
  vertical: boolean;
  onSelect?: undefined;
}) {
  return (
    <div className="space-y-2.5 border-t border-border p-4">
      {clips.some((c) => c.image) && (
        <div className="flex items-stretch gap-2">
          <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded bg-muted font-mono text-xs text-muted-foreground">
            画面
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {clips.map((c, i) => (
              <div
                key={c.name}
                className="relative shrink-0 overflow-hidden rounded-md border border-border"
                title={c.text}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.image} alt={c.name} className={`w-auto object-cover ${vertical ? "h-28" : "h-24"}`} />
                <span className="absolute left-1 top-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                  {i + 1}
                </span>
                {c.dur != null && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                    {c.dur.toFixed(1)}s
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {wave && (
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-12 shrink-0 flex-col items-center justify-center rounded bg-muted font-mono text-xs text-muted-foreground">
            配音
          </div>
          <button
            onClick={() => audio && new Audio(audio).play()}
            className="relative h-12 min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-muted/60 text-left"
            title="点击播放配音"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={wave} alt="配音波形" className="h-full w-full object-fill opacity-90" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── the review gate ──

function GateBar({ stageId, onDone }: { stageId: string; onDone: () => void }) {
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
    onDone();
    router.refresh();
  }

  return (
    <div className="border-t border-accent/25 bg-accent-soft/50 p-4">
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
          className="rounded-full bg-foreground px-6 py-2.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
        >
          通过,继续往下
        </button>
        {!rejecting ? (
          <button
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="rounded-full bg-destructive/10 px-5 py-2.5 text-sm text-destructive hover:bg-destructive/15 disabled:opacity-40"
          >
            打回
          </button>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={() => resolve("reject")}
              className="rounded-full bg-destructive px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              确认打回
            </button>
            <button
              onClick={() => {
                setRejecting(false);
                setNote("");
                setErr("");
              }}
              className="rounded-full px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground"
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
  );
}
