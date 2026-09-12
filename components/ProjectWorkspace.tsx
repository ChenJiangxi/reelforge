"use client";

import { useState } from "react";
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
}: {
  projectId: string;
  stages: StageView[];
  messages: ChatMessage[];
  clips: ClipThumb[];
  aspect: string;
  audio?: string;
  wave?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const awaiting = stages.find((s) => s.status === "awaiting_review");

  return (
    <>
      {/* stepper = stage selector */}
      <div className="mb-4 flex items-center rounded-lg border border-border bg-card px-4 py-3">
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
                  className={`whitespace-nowrap text-[10px] ${
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

      <div className="editor-grid">
        <div className="order-2 lg:order-1">
          <ChatPanel projectId={projectId} messages={messages} />
        </div>
        <div className="order-1 lg:order-2">
          <PreviewPane
            stages={stages}
            clips={clips}
            aspect={aspect}
            audio={audio}
            wave={wave}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </div>
    </>
  );
}
