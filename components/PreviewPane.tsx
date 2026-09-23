"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type Artifacts, type Comment } from "@/lib/stages";
import { DecisionList, type BeatInfo, type DecisionSet } from "@/components/DecisionList";
import { RerunForm } from "@/components/RerunForm";
import { CallLog } from "@/components/CallLog";
import { useStatus } from "@/components/useStatus";
import { Timeline, type TlBeat, type TlInsert } from "@/components/Timeline";
import { VersionButton, VersionView } from "@/components/Versions";

export type ClipThumb = {
  name: string;
  text: string;
  image?: string;
  dur?: number;
  gap?: number;
  kind?: BeatInfo["kind"];
  overrides?: BeatInfo["overrides"];
};
export type StageView = {
  id: string;
  kind: string;
  order: number;
  status: string;
  artifacts: Artifacts;
  comments: Comment[];
};
export type RerunRequest = { kind: string; note: string; nonce: number };

const VIDEO_KINDS = ["edit", "subtitles", "polish"];

// 某个视频阶段旁边要摆哪些决定:它自己的 + 它底下那几层的逐拍决定(成片里看到的每一拍,
// 进画/速度/运镜是剪辑定的)。剪辑的决定可以直接改。
function decisionSetsFor(view: StageView, stages: StageView[]): DecisionSet[] {
  const of = (k: string) => stages.find((s) => s.kind === k);
  const own: DecisionSet = { stage: view.kind, decisions: view.artifacts.decisions, editable: view.kind === "edit" };
  if (!VIDEO_KINDS.includes(view.kind)) return [own];
  const below = VIDEO_KINDS.slice(0, VIDEO_KINDS.indexOf(view.kind)).reverse();
  return [
    own,
    ...below.map((k) => ({ stage: k, decisions: of(k)?.artifacts.decisions, editable: k === "edit" })),
  ];
}

function beatsFrom(clips: ClipThumb[]): BeatInfo[] {
  let t = 0;
  return clips.map((c) => {
    const b: BeatInfo = { name: c.name, text: c.text, kind: c.kind, overrides: c.overrides, offset: c.dur != null ? t : undefined };
    t += (c.dur ?? 0) + (c.gap ?? 0.25);
    return b;
  });
}

// 预览区 = 阶段查看器:进度条点哪段,这里就看哪段。
// 默认视图:待审 > 最新成片 > 制作中占位。审核门只在待审阶段出现。
function useAssign(projectId: string) {
  const router = useRouter();
  const [over, setOver] = useState<string | null>(null);
  const assign = async (clip: string, asset: string) => {
    await fetch(`/api/project/${projectId}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clip, asset }),
    });
    router.refresh();
  };
  const dropProps = (clip: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("application/x-rf-asset")) {
        e.preventDefault();
        setOver(clip);
      }
    },
    onDragLeave: () => setOver((o) => (o === clip ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const asset = e.dataTransfer.getData("application/x-rf-asset");
      setOver(null);
      if (asset) assign(clip, asset);
    },
  });
  return { over, dropProps };
}

export function PreviewPane({
  stages,
  clips,
  aspect,
  audio,
  wave,
  subs = [],
  selectedId,
  onSelect,
  projectId,
  rerunRequest,
  tlBeats = [],
  tlInserts = [],
  voiceTotal = 0,
}: {
  stages: StageView[];
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
  subs?: { text: string; start: number; end: number }[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  projectId: string;
  rerunRequest?: RerunRequest | null;
  tlBeats?: TlBeat[];
  tlInserts?: TlInsert[];
  voiceTotal?: number;
}) {
  const vertical = aspect !== "16:9";
  const { over, dropProps } = useAssign(projectId);
  const [rerun, setRerun] = useState<{ stageId: string; note: string; allowSwitch: boolean } | null>(null);
  const [activeBeat, setActiveBeat] = useState<string | null>(null);
  const [callsFor, setCallsFor] = useState<string | null>(null); // 打开了哪个阶段的调用记录
  const [viewV, setViewV] = useState<{ stageId: string; v: number } | null>(null); // 在看哪一步的哪个旧版
  const awaiting = stages.find((s) => s.status === "awaiting_review");
  const withVideo = [...stages].reverse().find((s) => s.artifacts.video);
  const working = stages.find((s) => s.status === "working");

  // 聊天里说"重做 XX" → LLM 只猜阶段,不执行:在这里打开重做表(阶段可换),她确认了才算
  const [dismissed, setDismissed] = useState<number | null>(null);
  const fromChat =
    rerunRequest && rerunRequest.nonce !== dismissed ? stages.find((x) => x.kind === rerunRequest.kind) : undefined;
  const openRerun = rerun ?? (fromChat ? { stageId: fromChat.id, note: rerunRequest!.note, allowSwitch: true } : null);
  const closeRerun = () => {
    setRerun(null);
    if (rerunRequest) setDismissed(rerunRequest.nonce);
  };

  const view: StageView | null =
    stages.find((s) => s.id === selectedId) ?? awaiting ?? withVideo ?? working ?? stages[0] ?? null;
  const isAwaiting = view?.status === "awaiting_review";
  const failure = view && view.status === "changes_requested" ? failureOf(view) : null;
  const showingCut = view != null && withVideo != null && view.id === withVideo.id;
  const showTracks = !!view?.artifacts.video && VIDEO_KINDS.includes(view.kind);
  const isVideoView = !!view?.artifacts.video && VIDEO_KINDS.includes(view.kind) && view.status !== "working";
  const beats = beatsFrom(clips);
  const canRedo = view != null && (view.status === "approved" || (view.status === "pending" && !!view.artifacts.note));

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        还没有内容
      </div>
    );
  }

  const decisionPanel = (
    <DecisionList
      sets={decisionSetsFor(view, stages)}
      beats={beats}
      projectId={projectId}
      activeBeat={activeBeat}
      dropProps={isVideoView ? dropProps : undefined}
      over={over}
    />
  );
  const showSidePanel = !isVideoView && view.status !== "working" && !(view.status === "pending" && !view.artifacts.note);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <span className="text-sm font-semibold">{stageLabel(view.kind)}</span>
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
          {failure && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
              <span className="inline-block size-1.5 rounded-full bg-destructive" />
              没做成
            </span>
          )}
          {canRedo && !openRerun && (
            <button
              onClick={() => setRerun({ stageId: view.id, note: "", allowSwitch: false })}
              className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              title="重做这一步;会先列出哪些阶段跟着重出,你确认了才动"
            >
              重做这一步
            </button>
          )}
          {(view.artifacts.history?.length ?? 0) > 1 && (
            <VersionButton
              history={view.artifacts.history!}
              viewing={viewV?.stageId === view.id ? viewV.v : null}
              onPick={(v) => setViewV(v == null ? null : { stageId: view.id, v })}
            />
          )}
          {view.kind && view.status !== "pending" && (
            <button
              onClick={() => setCallsFor(callsFor === view.kind ? null : view.kind)}
              className={`rounded-full border px-3 py-1 text-xs hover:border-foreground/30 ${
                callsFor === view.kind ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground"
              }`}
              title="这一步每次问模型 / 配音的原始请求和返回"
            >
              调用记录
            </button>
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

      {viewV?.stageId === view.id && view.artifacts.history ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <VersionView stageId={view.id} kind={view.kind} history={view.artifacts.history} v={viewV.v} vertical={vertical} onClose={() => setViewV(null)} />
        </div>
      ) : callsFor === view.kind ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CallLog key={view.kind} projectId={projectId} stage={view.kind} onClose={() => setCallsFor(null)} />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-3 lg:flex lg:gap-3 lg:overflow-hidden">
        <div className="min-h-0 min-w-0 lg:flex-1 lg:overflow-y-auto">
          {failure && (
            <FailureBanner
              failure={failure}
              onRetry={() => setRerun({ stageId: view.id, note: "", allowSwitch: false })}
            />
          )}
          <StageArtifact
            stage={view}
            stages={stages}
            vertical={vertical}
            clips={clips}
            audio={audio}
            wave={wave}
            projectId={projectId}
            dropProps={dropProps}
            over={over}
            onSelect={onSelect}
            decisionPanel={decisionPanel}
            onActiveBeat={setActiveBeat}
          />
        </div>
        {showSidePanel && (
          <aside className="mt-3 flex min-h-0 flex-col border-t border-border/70 lg:mt-0 lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0">
            {decisionPanel}
          </aside>
        )}
      </div>
      )}

      {showTracks && !openRerun && tlBeats.length > 0 && (
        <Timeline projectId={projectId} beats={tlBeats} inserts={tlInserts} wave={wave} voiceTotal={voiceTotal} subs={subs} />
      )}

      {openRerun ? (
        <RerunForm
          key={`${openRerun.stageId}-${openRerun.note}`}
          stages={stages.map((s) => ({ id: s.id, kind: s.kind, status: s.status }))}
          stageId={openRerun.stageId}
          initialNote={openRerun.note}
          allowSwitch={openRerun.allowSwitch}
          onClose={closeRerun}
        />
      ) : (
        isAwaiting && (
          <GateBar
            stageId={view.id}
            onDone={() => onSelect(null)}
            onReject={() => setRerun({ stageId: view.id, note: "", allowSwitch: false })}
          />
        )
      )}
    </div>
  );
}

// ── 失败:说清卡在哪一拍、哪一步,给一个重试 ──

type FailureView = { beat?: string; step?: string; message: string; kind?: string };

function failureOf(stage: StageView): FailureView | null {
  const f = stage.artifacts.failure;
  if (f) return f;
  const note = stage.artifacts.note ?? "";
  if (note.startsWith("FAILED:")) return { message: note.replace(/^FAILED:\s*/, "") };
  return null;
}

function FailureBanner({ failure, onRetry }: { failure: FailureView; onRetry: () => void }) {
  const where = [
    failure.beat ? `第 ${Number(failure.beat.slice(1))} 拍(${failure.beat})` : "",
    failure.step ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto mb-3 max-w-2xl border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-sm">
      <div className="font-medium text-destructive">
        没做成{where ? `,卡在 ${where}` : ""}
      </div>
      <div className="mt-0.5 break-words text-xs text-foreground/80">{failure.message}</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onRetry}
          className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background hover:opacity-85"
        >
          重试
        </button>
        <span className="text-xs text-muted-foreground">
          {failure.kind === "disk" ? "渲染机磁盘空出来之后会自动接着做" : "下面是上一版能看的产物(如果有)"}
        </span>
      </div>
    </div>
  );
}

// ── artifact renderer, by stage kind ──

function StageArtifact({
  stage,
  stages,
  vertical,
  clips,
  audio,
  wave,
  projectId,
  dropProps,
  over,
  onSelect,
  decisionPanel,
  onActiveBeat,
}: {
  stage: StageView;
  stages: StageView[];
  vertical: boolean;
  clips: ClipThumb[];
  audio?: string;
  wave?: string;
  projectId: string;
  dropProps?: (clip: string) => Record<string, unknown>;
  over?: string | null;
  onSelect?: (id: string | null) => void;
  decisionPanel: React.ReactNode;
  onActiveBeat: (beat: string | null) => void;
}) {
  const a = stage.artifacts;
  const pass = { stages, vertical, clips, audio, wave, projectId, dropProps, over, onSelect, decisionPanel, onActiveBeat };

  if (stage.status === "pending" && !stage.artifacts.video && !stage.artifacts.images?.length && !stage.artifacts.script && !stage.artifacts.note) {
    return (
      <div className="flex h-full items-center justify-center py-16 text-center text-sm text-muted-foreground">
        这个阶段还没做。
        <br />
        上游通过后 agent 才动手。
      </div>
    );
  }
  if (stage.status === "pending") {
    // 重做排队中:旧产物继续可看(下面照常渲染),上面加一行说明 —— 包括为什么在排队
    const q = stage.comments.filter((c) => c.decision === "queued").at(-1)?.text;
    const why = q ? (q.startsWith("因为") ? q : `因为${q}`) : "";
    return (
      <>
        <p className="mx-auto mb-3 max-w-2xl text-center text-xs text-accent">
          重做排队中{why ? `(${why})` : ""} —— 下面是上一版,新版出来自动替换
        </p>
        <StageArtifact stage={{ ...stage, status: "approved" }} {...pass} />
      </>
    );
  }
  if (stage.status === "working") {
    return <WorkingProgress stage={stage} projectId={projectId} />;
  }

  const events = stage.comments.filter((c) => c.decision !== "queued").slice(-6);
  const commentsBlock = events.length > 0 && (
    <div className="mx-auto mt-4 max-w-2xl space-y-1 text-xs text-muted-foreground">
      {events.map((c, i) => (
        <div key={i} className={c.decision === "failed" ? "text-destructive/80" : ""}>
          {c.decision === "failed" ? "✕" : "💬"} {c.text}{" "}
          <span className="text-muted-foreground/50">
            ({c.decision === "reject" ? "打回" : c.decision === "comment" ? "批注" : c.decision === "approve" ? "通过" : c.decision === "failed" ? "失败" : c.decision})
          </span>
        </div>
      ))}
    </div>
  );

  let body: React.ReactNode = null;
  if (stage.kind === "topic") {
    body = (
      <div className="mx-auto flex h-full max-w-3xl flex-col">
        <pre className="flex-1 whitespace-pre-wrap rounded-lg bg-card p-6 text-sm leading-[1.8] text-foreground/85">
          {a.note}
        </pre>
      </div>
    );
  } else if (stage.kind === "script") {
    body = <ScriptEditor stage={stage} projectId={projectId} />;
  } else if (stage.kind === "footage" && a.images?.length) {
    body = <CardStrip images={a.images} cards={a.cards ?? []} onIndex={(i) => onActiveBeat(a.cards?.[i]?.name ?? null)} />;
  } else if (stage.kind === "voice") {
    body = <VoiceTakes stage={stage} projectId={projectId} fallback={{ audio, wave }} onSelect={onSelect} />;
  } else if (a.video) {
    body = (
      <VideoWithBeatRail
        stage={stage}
        vertical={vertical}
        clips={clips}
        dropProps={dropProps}
        over={over}
        decisionPanel={decisionPanel}
        onActiveBeat={onActiveBeat}
      />
    );
  } else if (stage.kind === "deliver") {
    body = (
      <div className="mx-auto flex max-w-3xl flex-wrap items-start justify-center gap-4">
        {a.cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.cover} alt="封面" className="w-44 rounded-md border border-border" />
        )}
        {a.caption && (
          <div className="min-w-56 flex-1 rounded-md bg-card p-4 text-sm">
            <div className="font-medium">{a.caption.title}</div>
            <div className="mt-1 text-accent">{a.caption.hashtags.join(" ")}</div>
            <div className="mt-1 text-muted-foreground">{a.caption.desc}</div>
          </div>
        )}
      </div>
    );
  }
  const noteOnly = !body && !!a.note && !a.note.startsWith("FAILED:");

  return (
    <>
      {body}
      {noteOnly && <p className="mx-auto max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">{a.note}</p>}
      {a.note && !a.note.startsWith("FAILED:") && body && !["topic", "script"].includes(stage.kind) && (
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
      <div className="group relative mx-auto flex h-full max-w-3xl flex-col">
        <pre className="flex-1 whitespace-pre-wrap rounded-lg bg-card p-6 text-sm leading-[1.8] text-foreground/85">
          {text}
        </pre>
        <button
          onClick={() => {
            setDraft(text);
            setEditing(true);
          }}
          className="absolute right-3 top-3 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-xs transition hover:border-foreground/30 hover:text-foreground"
        >
          ✎ 直接改
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-0 flex-1 w-full resize-none overflow-y-auto rounded-lg border border-accent/50 bg-card p-5 text-sm leading-[1.8] outline-none focus:border-accent"
      />
      <div className="mt-2 flex shrink-0 items-center gap-2">
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

// ── 配音:两版念法摆一起听,点一个定稿 ──────────────────────────────
// 配音好不好听没法用规则定死,与其猜,不如给两个方向明确不同的版本让她选。
// 选完了这个方向会写回脚本,之后重出不会打回原形。

function VoiceTakes({
  stage,
  projectId,
  fallback,
  onSelect,
}: {
  stage: StageView;
  projectId: string;
  fallback: { audio?: string; wave?: string };
  onSelect?: (id: string | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const a = stage.artifacts;
  const takes = a.takes;
  // 定稿之后也允许换回来:听完成片才发现节奏不对是常事,回到这一步点另一版
  // 比打回重出快得多(换版只重出剪辑/字幕,稿子和画面都不动)。
  const canPick = stage.status === "awaiting_review" || stage.status === "approved";

  async function pick(take: "a" | "b") {
    if (busy) return;
    setBusy(take);
    await fetch(`/api/project/${projectId}/voice-take`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ take }),
    });
    setBusy(null);
    // 选完这个阶段就不再"待审"了,不钉住的话预览会跳回第一个阶段 —— 她刚点完的东西不该消失
    onSelect?.(stage.id);
    router.refresh();
  }

  // 老项目只有一版
  if (!takes) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 rounded-lg bg-card p-5">
        {(a.wave || fallback.wave) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.wave ?? fallback.wave} alt="波形" className="w-full rounded border border-border" />
        )}
        {(a.audio || fallback.audio) && <audio controls className="w-full" src={a.audio ?? fallback.audio} autoPlay />}
      </div>
    );
  }

  const rows: { key: "a" | "b"; t: NonNullable<Artifacts["takes"]>["a"] }[] = [
    { key: "a", t: takes.a },
    { key: "b", t: takes.b },
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto">
      {rows.map(({ key, t }, i) => {
        const current = takes.picked === key;
        return (
          <div
            key={key}
            className={`flex flex-col gap-2 rounded-lg p-4 ${current ? "bg-accent-soft/50" : "bg-card"}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{i === 0 ? "A" : "B"}</span>
              <span className="text-sm font-medium">{t.label}</span>
              {t.total != null && <span className="font-mono text-xs text-muted-foreground">{t.total}s</span>}
              {current && <span className="text-xs font-medium text-accent">当前用的是这版</span>}
              {canPick && (
                <button
                  onClick={() => pick(key)}
                  disabled={!!busy || (current && stage.status !== "awaiting_review")}
                  className={`ml-auto rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                    current
                      ? "border border-border text-muted-foreground hover:border-foreground/30"
                      : "bg-foreground text-background hover:opacity-85"
                  }`}
                >
                  {busy === key
                    ? "定稿中…"
                    : current
                      ? stage.status === "awaiting_review" ? "就用这版,继续往下" : "用的就是这版"
                      : stage.status === "awaiting_review" ? "换成这版" : "换成这版,重出剪辑"}
                </button>
              )}
            </div>
            {t.wave && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.wave} alt={`${t.label}波形`} className="h-14 w-full rounded border border-border object-cover" />
            )}
            <audio controls className="w-full" src={t.audio} />
          </div>
        );
      })}
      {stage.status === "awaiting_review" && (
        <p className="text-center text-xs text-muted-foreground">
          两版都不对就用下面的「打回」,直接说「第3拍太平」「开头再快点」
        </p>
      )}
    </div>
  );
}

// ── 素材审阅:横向滑动,一张一张过(像刷抖音),带吸附/计数/箭头 ──

function CardStrip({
  images,
  cards,
  onIndex,
}: {
  images: string[];
  cards: { text?: string; asset?: string }[];
  onIndex?: (i: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [idx, setIdxRaw] = useState(0);
  const setIdx = (i: number) => {
    setIdxRaw(i);
    onIndex?.(i);
  };
  const n = images.length;

  const figs = () =>
    Array.from(stripRef.current?.querySelectorAll("figure") ?? []) as HTMLElement[];

  // 用每张卡的真实位置定位,不按"平均宽度"估算 —— 用了真素材的那几拍宽度和字卡不一样
  const goTo = (i: number) => {
    const el = stripRef.current;
    const f = figs()[Math.max(0, Math.min(n - 1, i))];
    if (!el || !f) return;
    // scrollIntoView 比 scrollTo 可靠:snap-mandatory 下平滑 scrollTo 会被吸附取消
    f.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setIdx(Math.max(0, Math.min(n - 1, i)));
  };
  const onScroll = () => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 贴边时直接认边:最后一张卡贴右边缘,按"离中心最近"会算成倒数第二张
    if (el.scrollLeft <= 2) { setIdx(0); return; }
    if (el.scrollLeft >= max - 2) { setIdx(n - 1); return; }
    const center = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestD = Infinity;
    figs().forEach((f, i) => {
      const d = Math.abs(f.offsetLeft + f.clientWidth / 2 - center);
      if (d < bestD) { bestD = d; best = i; }
    });
    setIdx(best);
  };

  // 桌面端:竖滚轮直接横滑这条素材带(不然要按住 shift 才能横滚,没人知道)
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = el.scrollLeft + e.deltaY;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, next));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const cur = cards[idx];
  const curLabel = cur?.asset ? `\u{1F3AC} ${cur.asset}` : (cur?.text ?? "");

  return (
    <div className="relative flex h-full min-h-[58vh] w-full min-w-0 flex-col lg:min-h-0">
      <div className="mb-2 flex shrink-0 items-center gap-3">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {Math.min(idx + 1, n)} / {n}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={curLabel}>
          {curLabel}
        </span>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={() => goTo(idx - 1)}
            disabled={idx <= 0}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/30 disabled:opacity-30"
          >
            ←
          </button>
          <button
            onClick={() => goTo(idx + 1)}
            disabled={idx >= n - 1}
            className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/30 disabled:opacity-30"
          >
            →
          </button>
        </div>
      </div>

      <div
        ref={stripRef}
        onScroll={onScroll}
        className="flex min-h-0 w-full min-w-0 flex-1 snap-x snap-mandatory items-center gap-3 overflow-x-auto overflow-y-hidden pb-2"
      >
        {images.map((src, i) => (
          <figure
            key={i}
            onClick={() => goTo(i)}
            className="flex h-full max-h-full shrink-0 snap-center flex-col items-center justify-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`卡 ${i + 1}`}
              loading="lazy"
              className={`max-h-full w-auto max-w-[78vw] rounded-md border object-contain sm:max-w-[42vw] lg:max-w-none ${
                i === idx ? "border-accent/60" : "border-border"
              }`}
            />
          </figure>
        ))}
      </div>

      {/* 拍号导航:12 拍时箭头一张张点太慢,点号直接跳 */}
      {n > 1 && (
        <div className="mt-1 flex shrink-0 flex-wrap items-center justify-center gap-1">
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              title={cards[i]?.asset ? `🎬 ${cards[i]?.asset}` : (cards[i]?.text ?? `第 ${i + 1} 拍`)}
              className={`h-5 min-w-5 rounded px-1 font-mono text-[10px] transition ${
                i === idx
                  ? "bg-foreground text-background"
                  : cards[i]?.asset
                    ? "text-accent hover:bg-muted"
                    : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 视频 + 决定清单:清单就摆在成片旁边,点哪拍跳哪拍,播到哪拍亮哪拍 ──

function VideoWithBeatRail({
  stage,
  vertical,
  clips,
  decisionPanel,
  onActiveBeat,
}: {
  stage: StageView;
  vertical: boolean;
  clips: ClipThumb[];
  dropProps?: (clip: string) => Record<string, unknown>;
  over?: string | null;
  decisionPanel: React.ReactNode;
  onActiveBeat: (beat: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const GAP = 0.25; // 兜底:旧项目的 voiceMeta 里没有每拍 gap
  const offsets: number[] = [];
  {
    let t = 0;
    for (const c of clips) {
      offsets.push(t);
      t += (c.dur ?? 0) + (c.gap ?? GAP);
    }
  }
  const seek = (name: string) => {
    const i = clips.findIndex((c) => c.name === name);
    const v = videoRef.current;
    if (v && i >= 0) {
      v.currentTime = offsets[i] ?? 0;
      v.play().catch(() => {});
    }
  };
  const lastBeat = useRef<string | null>(null);
  // 和时间轴联动:播放时把当前时间广播出去(播放头跟着走);时间轴上点哪,这里跳哪
  useEffect(() => {
    const v = videoRef.current;
    let raf = 0;
    const loop = () => {
      if (v) window.dispatchEvent(new CustomEvent("rf-time", { detail: v.currentTime }));
      if (v && !v.paused) raf = requestAnimationFrame(loop);
    };
    const onPlay = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };
    const onSeek = (e: Event) => {
      if (!v) return;
      v.currentTime = (e as CustomEvent<number>).detail;
      window.dispatchEvent(new CustomEvent("rf-time", { detail: v.currentTime }));
    };
    v?.addEventListener("play", onPlay);
    v?.addEventListener("seeked", loop);
    window.addEventListener("rf-seek", onSeek);
    return () => {
      cancelAnimationFrame(raf);
      v?.removeEventListener("play", onPlay);
      v?.removeEventListener("seeked", loop);
      window.removeEventListener("rf-seek", onSeek);
    };
  }, [stage.artifacts.video]);
  const onTime = () => {
    const v = videoRef.current;
    if (!v || !clips.length) return;
    let i = 0;
    while (i + 1 < offsets.length && offsets[i + 1] <= v.currentTime) i++;
    const name = clips[i]?.name ?? null;
    if (name !== lastBeat.current) {
      lastBeat.current = name;
      onActiveBeat(name);
    }
  };

  return (
    <div className={`flex h-full gap-3 ${vertical ? "flex-col items-stretch lg:flex-row" : "flex-col items-center"}`}>
      <video
        ref={videoRef}
        key={stage.artifacts.video}
        controls
        autoPlay={stage.status === "awaiting_review"}
        onTimeUpdate={onTime}
        className={`rounded-md border border-border bg-black ${vertical ? "mx-auto max-h-[70vh] w-auto lg:max-h-full" : "w-full max-w-3xl"}`}
        src={stage.artifacts.video}
      />
      <div
        className={`flex min-h-0 flex-col border-border/70 ${
          vertical ? "border-t lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0" : "w-full max-w-3xl border-t"
        }`}
        onClickCapture={(e) => {
          // 决定清单里点拍号 → 视频跳到那一拍
          const el = (e.target as HTMLElement).closest("[data-beat]") as HTMLElement | null;
          if (el?.dataset.beat) seek(el.dataset.beat);
        }}
      >
        {decisionPanel}
      </div>
    </div>
  );
}

// ── the review gate ──

function GateBar({ stageId, onDone, onReject }: { stageId: string; onDone: () => void; onReject: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    await fetch("/api/stage/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId, decision: "approve" }),
    });
    setBusy(false);
    onDone();
    router.refresh();
  }

  return (
    <div className="border-t border-border/70 bg-accent-soft/40 p-3">
      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          onClick={approve}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
        >
          通过,继续往下
        </button>
        <button
          disabled={busy}
          onClick={onReject}
          className="rounded-full bg-destructive/10 px-4 py-2 text-sm text-destructive hover:bg-destructive/15 disabled:opacity-40"
        >
          打回
        </button>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
          打回前会列出哪些阶段跟着重出
        </span>
      </div>
    </div>
  );
}

// ── 制作中:实时进度(渲染机每 5 秒心跳带来的)──
function WorkingProgress({ stage, projectId }: { stage: StageView; projectId: string }) {
  const st = useStatus(projectId, true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const job = st?.jobs.find((j) => j.stageId === stage.id);
  const idx = job?.beat ? Number(job.beat.replace(/^c/, "")) : null;
  const elapsed = job?.startedAt ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : null;
  const up = job?.upload && job.upload.total ? job.upload : null;
  const pct = up ? Math.round((up.sent / up.total) * 100) : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center text-sm text-muted-foreground">
      <div>
        <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-accent" />
        正在做「{stageLabel(stage.kind)}」
        {elapsed != null && <span className="ml-1 font-mono text-xs">· 已经 {elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`}</span>}
      </div>
      {job ? (
        <div className="text-foreground/85">
          {idx != null && job.total ? `第 ${idx}/${job.total} 拍(${job.beat})· ` : job.beat ? `${job.beat} · ` : ""}
          {job.step ?? "准备中"}
        </div>
      ) : st && !st.worker.online ? (
        <div className="text-destructive">渲染机现在不在线,进度看不到(见页面顶上的提示)</div>
      ) : (
        <div>等渲染机报进度…</div>
      )}
      {up && (
        <div className="mt-1 w-64">
          <div className="mb-1 flex justify-between font-mono text-[11px]">
            <span>{up.label}</span>
            <span>
              {pct}% · {(up.sent / 1048576).toFixed(1)}/{(up.total / 1048576).toFixed(1)} MB
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
