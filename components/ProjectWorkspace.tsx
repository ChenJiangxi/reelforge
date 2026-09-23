"use client";

import { useRef, useState } from "react";
import { ChatPanel, type ChatMessage } from "@/components/ChatPanel";
import { PreviewPane, type ClipThumb, type RerunRequest, type StageView } from "@/components/PreviewPane";
import type { TlBeat, TlInsert } from "@/components/Timeline";
import { stageLabel } from "@/lib/stages";

const DOT: Record<string, string> = {
  approved: "bg-success",
  awaiting_review: "bg-accent",
  working: "bg-accent animate-pulse",
  changes_requested: "bg-destructive",
  pending: "bg-border",
};

const STATUS_TEXT: Record<string, string> = {
  approved: "已通过",
  awaiting_review: "待你审",
  working: "制作中",
  changes_requested: "打回重做中 / 没做成",
  pending: "排队中",
};

// The whole working area: clickable pipeline stepper on top (切任何阶段进预览),
// chat left + stage viewer right below.
export function ProjectWorkspace({
  projectId,
  stages,
  messages,
  clips,
  aspect,
  audio,
  wave,
  subs = [],
  tlBeats = [],
  tlInserts = [],
  voiceTotal = 0,
}: {
  projectId: string;
  stages: StageView[];
  messages: ChatMessage[];
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
  subs?: { text: string; start: number; end: number }[];
  tlBeats?: TlBeat[];
  tlInserts?: TlInsert[];
  voiceTotal?: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 聊天里说了"重做 XX":LLM 猜的阶段只用来打开右边的重做表,她确认了才执行
  const [rerunRequest, setRerunRequest] = useState<RerunRequest | null>(null);
  const onSuggest = (s: { kind: string; note: string }) => {
    const target = stages.find((x) => x.kind === s.kind);
    if (target) setSelectedId(target.id);
    setRerunRequest({ ...s, nonce: Date.now() });
  };
  const awaiting = stages.find((s) => s.status === "awaiting_review");

  // 聊天/预览分栏宽度可拖(双击复位;拖动范围 280–560px)
  const [chatW, setChatW] = useState(360);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startW: chatW };
    const move = (ev: PointerEvent) => {
      if (!drag.current) return;
      const w = drag.current.startW + (ev.clientX - drag.current.startX);
      setChatW(Math.min(560, Math.max(280, Math.round(w))));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      {/* stepper = stage selector */}
      <div className="mb-2 flex shrink-0 items-center border-b border-border/70 px-2 py-2.5">
        {stages.map((s, i) => {
          const selected = selectedId === s.id || (selectedId === null && awaiting?.id === s.id);
          return (
            <div key={s.id} className="flex min-w-0 flex-1 items-center last:flex-none">
              <button
                onClick={() => setSelectedId(selected ? null : s.id)}
                title={`${stageLabel(s.kind)} · ${STATUS_TEXT[s.status] ?? s.status}`}
                className="group flex flex-col items-center gap-1"
              >
                <span
                  className={`size-2 rounded-full transition ${DOT[s.status] ?? DOT.pending} ${
                    selected ? "ring-4 ring-accent-soft" : "group-hover:ring-2 group-hover:ring-muted"
                  }`}
                />
                <span
                  className={`whitespace-nowrap text-[11px] ${
                    selected
                      ? "font-medium text-accent"
                      : s.status === "awaiting_review"
                        ? "font-medium text-accent"
                        : "text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  {stageLabel(s.kind)}
                </span>
              </button>
              {i < stages.length - 1 && (
                <div className={`mx-1 mb-4 h-px min-w-2 flex-1 ${s.status === "approved" ? "bg-success/50" : "bg-border"}`} />
              )}
            </div>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        {/* 聊天框只挂一份:以前桌面/手机各挂一份(另一份 CSS 藏起来),两份各自维护待发消息和滚动,
            页面里也有两个输入框。宽度改成只在桌面生效的 CSS 变量。 */}
        <div
          className="order-2 min-h-0 min-w-0 lg:order-1 lg:h-full lg:w-[var(--chat-w)] lg:shrink-0"
          style={{ "--chat-w": `${chatW}px` } as React.CSSProperties}
        >
          <ChatPanel projectId={projectId} messages={messages} onSuggestRedo={onSuggest} />
        </div>
        {/* 拖拽分隔条(桌面端) */}
        <div
          onPointerDown={onHandleDown}
          onDoubleClick={() => setChatW(360)}
          title="拖动调整聊天区宽度,双击复位"
          className="order-2 hidden w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full bg-border/60 hover:bg-accent/50 lg:block"
        />
        <div className="order-1 min-h-0 min-w-0 flex-1 lg:order-3">
          <PreviewPane
            stages={stages}
            clips={clips}
            aspect={aspect}
            audio={audio}
            wave={wave}
            subs={subs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            projectId={projectId}
            rerunRequest={rerunRequest}
            tlBeats={tlBeats}
            tlInserts={tlInserts}
            voiceTotal={voiceTotal}
          />
        </div>
      </div>
    </>
  );
}
