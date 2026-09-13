"use client";

import { useRef, useState } from "react";
import { ChatPanel, type ChatMessage } from "@/components/ChatPanel";
import { PreviewPane, type ClipThumb, type StageView } from "@/components/PreviewPane";
import { stageLabel } from "@/lib/stages";

const DOT: Record<string, string> = {
  approved: "bg-success",
  awaiting_review: "bg-accent",
  working: "bg-accent animate-pulse",
  changes_requested: "bg-destructive",
  pending: "bg-border",
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
}: {
  projectId: string;
  stages: StageView[];
  messages: ChatMessage[];
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
  subs?: { text: string; start: number; end: number }[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      <div className="mb-3 flex shrink-0 items-center rounded-lg border border-border bg-card px-4 py-2.5">
        {stages.map((s, i) => {
          const selected = selectedId === s.id || (selectedId === null && awaiting?.id === s.id);
          return (
            <div key={s.id} className="flex min-w-0 flex-1 items-center last:flex-none">
              <button
                onClick={() => setSelectedId(selected ? null : s.id)}
                title={`${stageLabel(s.kind)} · ${s.status}`}
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
        <div className="order-2 min-h-0 lg:order-1 lg:shrink-0">
          <div className="hidden h-full lg:block" style={{ width: chatW }}>
            <ChatPanel projectId={projectId} messages={messages} />
          </div>
          <div className="lg:hidden">
            <ChatPanel projectId={projectId} messages={messages} />
          </div>
        </div>
        {/* 拖拽分隔条(桌面端) */}
        <div
          onPointerDown={onHandleDown}
          onDoubleClick={() => setChatW(360)}
          title="拖动调整聊天区宽度,双击复位"
          className="order-2 hidden w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full bg-border/60 hover:bg-accent/50 lg:block"
        />
        <div className="order-1 min-h-0 flex-1 lg:order-3">
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
          />
        </div>
      </div>
    </>
  );
}
