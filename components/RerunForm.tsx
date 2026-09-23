"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { planRerun, stageLabel } from "@/lib/stages";

export type RerunStage = { id: string; kind: string; status: string };

// 重做 / 打回 / 重试 共用的表:先看清这次会动哪些阶段,再提交。
// 锁死的(硬依赖)取消不了;可选的(软依赖)默认跟着重出,她可以取消。
// 从聊天里打开时,阶段是 LLM 猜的 —— 所以这里可以换,提交前她看得见。
export function RerunForm({
  stages,
  stageId,
  initialNote = "",
  allowSwitch = false,
  onClose,
}: {
  stages: RerunStage[];
  stageId: string;
  initialNote?: string;
  allowSwitch?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [id, setId] = useState(stageId);
  const [note, setNote] = useState(initialNote);
  const [skip, setSkip] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const stage = stages.find((s) => s.id === id) ?? stages[0];
  const gate = stage.status === "awaiting_review";
  const failed = stage.status === "changes_requested";
  const statuses = useMemo(() => Object.fromEntries(stages.map((s) => [s.kind, s.status])), [stages]);
  const rows = planRerun({ redo: [stage.kind], skip }, statuses);
  const from = rows.findIndex((r) => r.state === "redo");
  const shown = rows.slice(from + 1);

  async function submit() {
    if (gate && !note.trim()) {
      setErr("打回要写一句原因,agent 照着改");
      return;
    }
    setErr("");
    setBusy(true);
    const r = await fetch("/api/stage/rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: stage.id, note: note.trim() || undefined, skip }),
    });
    setBusy(false);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setErr(d.error ?? `提交失败(${r.status})`);
      return;
    }
    onClose();
    router.refresh();
  }

  const verb = gate ? "打回" : failed ? "重试" : "重做";
  return (
    <div className="max-h-[55vh] overflow-y-auto border-t border-border/70 bg-accent-soft/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-medium">{verb}</span>
        {allowSwitch ? (
          <select
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setSkip([]);
            }}
            className="rounded-md border border-border bg-card px-2 py-0.5 text-sm outline-none focus:border-accent/60"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                「{stageLabel(s.kind)}」
              </option>
            ))}
          </select>
        ) : (
          <span className="font-medium">「{stageLabel(stage.kind)}」</span>
        )}
        {allowSwitch && <span className="text-xs text-muted-foreground">这一步是从你的话里猜的,不对就换</span>}
      </div>
      <textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          gate
            ? "打回原因(指到具体某句/某卡),agent 照着改…"
            : failed
              ? "可以不写,原样再试一次;要换个做法就写一句"
              : "要改什么(不写就原样重跑一遍)"
        }
        rows={2}
        className="w-full rounded-md border border-border bg-card p-2 text-sm outline-none focus:border-accent/60"
      />

      <div className="mt-2 text-xs">
        <div className="mb-1 text-muted-foreground">这次会动哪些阶段</div>
        <div className="divide-y divide-border/60">
          {shown.map((r) => {
            const lock = r.state === "hard";
            const soft = r.state === "soft" || r.state === "skipped";
            return (
              <label
                key={r.kind}
                className={`grid grid-cols-[3.2rem_7.5rem_1fr] items-baseline gap-x-2 py-1 ${soft && !r.queued ? "cursor-pointer" : ""}`}
              >
                <span className={r.state === "untouched" ? "text-muted-foreground" : "font-medium"}>{stageLabel(r.kind)}</span>
                <span>
                  {r.state === "untouched" ? (
                    <span className="text-muted-foreground">{r.queued ? "本来就在排队" : "不受影响"}</span>
                  ) : r.queued ? (
                    <span className="text-muted-foreground">
                      {statuses[r.kind] === "working" ? "正在做,作废重来" : "本来就在排队"}
                    </span>
                  ) : lock ? (
                    <span className="text-foreground">🔒 必须跟着重出</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={r.state === "soft"}
                        onChange={(e) =>
                          setSkip((s) => (e.target.checked ? s.filter((k) => k !== r.kind) : [...s, r.kind]))
                        }
                        className="accent-[var(--color-accent)]"
                      />
                      {r.state === "soft" ? "跟着重出" : "不重出,留着旧版"}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground">{r.why}</span>
              </label>
            );
          })}
          {!shown.length && <div className="py-1 text-muted-foreground">它是最后一步,不会连带别的阶段。</div>}
        </div>
      </div>

      {err && <div className="mt-2 text-xs text-destructive">{err}</div>}
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={busy}
          onClick={submit}
          className={`rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-40 ${
            gate ? "bg-destructive text-white hover:opacity-90" : "bg-foreground text-background hover:opacity-85"
          }`}
        >
          {busy ? "提交中…" : `确认${verb}`}
        </button>
        <button onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
          算了
        </button>
      </div>
    </div>
  );
}
