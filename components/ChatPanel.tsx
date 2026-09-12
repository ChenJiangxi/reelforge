"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type ChatMessage = { role: string; text: string; ts: number };

// The 对话剪辑 panel: chat with the pipeline. Clip edits (改第N句/删句/加句/改画面)
// and stage redos (封面换一版…) are parsed server-side; the review gate lives
// in the preview pane (审核模式), not here.
export function ChatPanel({
  projectId,
  messages,
}: {
  projectId: string;
  messages: ChatMessage[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // (page-wide freshness comes from <LiveRefresh /> in the layout)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending.length]);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText("");
    setPending((p) => [...p, { role: "user", text: t, ts: Date.now() }]);
    try {
      const r = await fetch(`/api/project/${projectId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const d = await r.json();
      setPending((p) => [...p, { role: "agent", text: d.reply ?? "(没听懂,换个说法试试)", ts: Date.now() }]);
      router.refresh();
    } catch {
      setPending((p) => [...p, { role: "agent", text: "网络错误,稍后再试。", ts: Date.now() }]);
    }
    setBusy(false);
  }

  return (
    <div className="flex h-full min-h-[60vh] flex-col rounded-lg border border-border bg-card shadow-xs">
      <div className="border-b border-border px-4 py-3">
        <div className="text-sm font-semibold">对话剪辑</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          直接说:把第3句改成… / 删掉第5句 / 封面换一版
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && pending.length === 0 && (
          <div className="rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            这就是 chatcut 那个聊天框。改词、删句、调画面、换封面,直接打字;
            agent 改完会重配音、重剪,右侧预览自动更新。
          </div>
        )}
        {[...messages, ...pending].map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                m.role === "user"
                  ? "rounded-br-sm bg-foreground text-background"
                  : "rounded-bl-sm bg-muted text-foreground"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="说一句修改…"
            rows={1}
            className="max-h-28 min-h-9 flex-1 resize-none rounded-full border border-border bg-background px-4 py-2 text-sm outline-none focus:border-accent/60"
          />
          <button
            onClick={send}
            disabled={busy || !text.trim()}
            className="shrink-0 rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
          >
            发
          </button>
        </div>
      </div>
    </div>
  );
}
