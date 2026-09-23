"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CAMERA_CHOICES,
  CAMERA_LABELS,
  DRAW_LABELS,
  FILL_LABELS,
  FIT_LABELS,
  describeOverride,
  stageLabel,
  type Decision,
  type Overrides,
} from "@/lib/stages";

export type BeatInfo = {
  name: string;
  text: string;
  /** video / image = 她的素材;anim / card = 设计卡 */
  kind?: "video" | "image" | "anim" | "card";
  overrides?: Overrides;
  offset?: number;
};

export type DecisionSet = { stage: string; decisions?: Decision[]; editable?: boolean };

// "这一步做了哪些决定" —— 摆在成片旁边。整体的决定在上,逐拍的决定按拍分组;
// 剪辑阶段标了 key 的决定可以直接点开改(= 挂在这一拍上的参数覆盖,持久、可撤销)。
export function DecisionList({
  sets,
  beats,
  projectId,
  activeBeat,
  onBeatClick,
  dropProps,
  over,
}: {
  sets: DecisionSet[];
  beats: BeatInfo[];
  projectId: string;
  activeBeat?: string | null;
  onBeatClick?: (beat: string) => void;
  /** 素材库里的素材可以直接拖到某一拍上(换这拍的画面) */
  dropProps?: (clip: string) => Record<string, unknown>;
  over?: string | null;
}) {
  const current = sets[0];
  const hasAny = sets.some((s) => s.decisions?.length);
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (!hasAny) {
    return (
      <div className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        这一版是加决定清单之前做的,没有记录这一步替你做了哪些决定。重出一次就有了。
      </div>
    );
  }

  const global = (current.decisions ?? []).filter((d) => !d.beat);
  const perBeat = new Map<string, { d: Decision; stage: string; editable: boolean }[]>();
  for (const set of sets) {
    for (const d of set.decisions ?? []) {
      if (!d.beat) continue;
      const list = perBeat.get(d.beat) ?? [];
      list.push({ d, stage: set.stage, editable: !!set.editable });
      perBeat.set(d.beat, list);
    }
  }
  const all = [...global, ...[...perBeat.values()].flat().map((x) => x.d)];
  const warnN = all.filter((d) => d.warn).length;
  const youN = all.filter((d) => d.by === "you").length;
  const beatOrder = beats.length ? beats.map((b) => b.name) : [...perBeat.keys()];

  return (
    <div className="flex min-h-0 flex-col text-xs">
      <div className="shrink-0 border-b border-border/70 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="whitespace-nowrap font-medium text-foreground">这一步做了哪些决定</span>
          {perBeat.size > 0 && (
            <button
              onClick={() => setExpandAll((v) => !(v ?? false))}
              className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground hover:text-foreground"
            >
              {expandAll ? "全部收起" : "全部展开"}
            </button>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {all.length} 条{warnN ? ` · ${warnN} 条标黄` : ""}
          {youN ? ` · ${youN} 条你定的` : ""}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {global.length > 0 && (
          <div className="border-b border-border/60 px-3 py-1.5">
            {global.map((d, i) =>
              current.editable && d.key === "sfx" ? (
                <EditableRow key={i} d={d} projectId={projectId} />
              ) : (
                <Row key={i} d={d} />
              ),
            )}
          </div>
        )}
        {beatOrder.map((name, i) => {
          const rows = perBeat.get(name);
          if (!rows?.length) return null;
          const info = beats.find((b) => b.name === name);
          const flagged = rows.some((r) => r.d.warn || r.d.by === "you");
          const isOpen = open[name] ?? expandAll ?? (flagged || activeBeat === name);
          const summary = rows
            .filter((r) => r.d.topic !== "画面" || rows.length === 1)
            .map((r) => r.d.choice)
            .join(" · ");
          return (
            <div
              key={name}
              {...(dropProps ? dropProps(name) : {})}
              className={`border-b border-border/60 ${activeBeat === name ? "bg-accent-soft/40" : ""} ${
                over === name ? "bg-accent-soft ring-1 ring-inset ring-accent" : ""
              }`}
            >
              <button
                data-beat={name}
                onClick={() => {
                  setOpen((o) => ({ ...o, [name]: !isOpen }));
                  onBeatClick?.(name);
                }}
                className="flex w-full items-baseline gap-2 px-3 pb-1 pt-1.5 text-left hover:bg-muted/60"
                title={info?.text}
              >
                <span className="shrink-0 font-mono text-[10px] text-accent">
                  {String(i + 1).padStart(2, "0")}
                  {info?.offset != null ? ` ${info.offset.toFixed(1)}s` : ""}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/85">{info?.text ?? name}</span>
                {rows.some((r) => r.d.warn) && <span className="shrink-0 text-[10px] text-accent">⚠</span>}
                {rows.some((r) => r.d.by === "you") && <span className="shrink-0 text-[10px] text-accent">你定的</span>}
                <span className="shrink-0 text-[10px] text-muted-foreground">{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen ? (
                <div className="px-3 pb-1.5">
                  {rows.map((r, j) =>
                    r.editable && r.d.key ? (
                      <EditableRow
                        key={j}
                        d={r.d}
                        beat={info}
                        projectId={projectId}
                        tag={r.stage !== current.stage ? stageLabel(r.stage) : undefined}
                      />
                    ) : (
                      <Row key={j} d={r.d} tag={r.stage !== current.stage ? stageLabel(r.stage) : undefined} />
                    ),
                  )}
                </div>
              ) : (
                <div className="truncate px-3 pb-1.5 pl-[3.1rem] text-[11px] text-muted-foreground">{summary}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ d, tag }: { d: Decision; tag?: string }) {
  return (
    <div className="grid grid-cols-[4.2rem_1fr] gap-x-2 py-0.5">
      <span className="truncate text-muted-foreground" title={d.topic}>
        {d.topic}
      </span>
      <span className="min-w-0">
        <span className={d.warn ? "font-medium text-accent" : "text-foreground"}>{d.choice}</span>
        {d.by === "you" && <span className="ml-1.5 text-[10px] text-accent">你定的</span>}
        {tag && <span className="ml-1.5 text-[10px] text-muted-foreground/70">{tag}</span>}
        {d.why && <span className="block text-[11px] leading-snug text-muted-foreground">{d.why}</span>}
      </span>
    </div>
  );
}

const SLOW_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

// 剪辑的决定:点一下展开选项,选完 = 这一拍的参数覆盖,只重跑剪辑(字幕/润色跟着走)。
function EditableRow({ d, beat, projectId, tag }: { d: Decision; beat?: BeatInfo; projectId: string; tag?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fromVal, setFromVal] = useState(String(d.value ?? 0));
  const key = d.key!;
  const projectLevel = key === "sfx"; // 整条片的设置,不挂在某一拍上
  const beatKey = projectLevel ? null : (key as keyof Overrides);
  const overridden = beatKey ? beat?.overrides?.[beatKey] != null : false;
  // 刚改了、剪辑还没重出:清单里还是上一版的值,旁边写上改成了什么
  const pendingVal = beatKey ? beat?.overrides?.[beatKey] : undefined;
  const pending = pendingVal != null && String(pendingVal) !== String(d.value);

  async function send(body: Record<string, unknown>) {
    if ((!beat && !projectLevel) || busy) return;
    setBusy(true);
    await fetch(`/api/project/${projectId}/override`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectLevel ? { project: { [key]: (body.set as Record<string, unknown>)?.[key] } } : { clip: beat!.name, ...body }),
    });
    setBusy(false);
    setEditing(false);
    router.refresh();
  }

  let options: { value: string | number; label: string }[] = [];
  if (key === "fit") options = Object.entries(FIT_LABELS).map(([value, label]) => ({ value, label }));
  else if (key === "fill") options = Object.entries(FILL_LABELS).map(([value, label]) => ({ value, label }));
  else if (key === "camera")
    options = (CAMERA_CHOICES[beat?.kind ?? "card"] ?? []).map((value) => ({ value, label: CAMERA_LABELS[value] ?? value }));
  else if (key === "slow") options = SLOW_STEPS.map((value) => ({ value, label: describeOverride("slow", value) }));
  else if (key === "draw") options = Object.entries(DRAW_LABELS).map(([value, label]) => ({ value, label }));
  else if (key === "sfx") options = [{ value: "on", label: "开" }, { value: "off", label: "关" }];

  return (
    <div className="grid grid-cols-[4.2rem_1fr] gap-x-2 py-0.5">
      <span className="truncate text-muted-foreground">{d.topic}</span>
      <span className="min-w-0">
        <button
          onClick={() => setEditing((e) => !e)}
          className={`rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground ${
            d.warn ? "font-medium text-accent" : "text-foreground"
          }`}
          title="点开改这一拍的参数"
        >
          {d.choice}
        </button>
        {pending && beatKey && <span className="ml-1.5 text-[11px] text-accent">→ {describeOverride(beatKey, pendingVal)}(等重剪)</span>}
        {overridden && (
          <>
            <span className="ml-1.5 text-[10px] text-accent">你定的</span>
            <button
              onClick={() => send({ unset: [beatKey] })}
              disabled={busy}
              className="ml-1.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              title="撤销,恢复成自动"
            >
              撤销
            </button>
          </>
        )}
        {tag && <span className="ml-1.5 text-[10px] text-muted-foreground/70">{tag}</span>}
        {d.why && <span className="block text-[11px] leading-snug text-muted-foreground">{d.why}</span>}
        {editing && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {key === "from" ? (
              <>
                <span className="text-muted-foreground">从第</span>
                <input
                  value={fromVal}
                  onChange={(e) => setFromVal(e.target.value)}
                  inputMode="decimal"
                  className="w-12 rounded border border-border bg-card px-1 py-0.5 font-mono text-[11px] outline-none focus:border-accent/60"
                />
                <span className="text-muted-foreground">秒开始</span>
                <Chip label={busy ? "…" : "确定"} onClick={() => send({ set: { from: Number(fromVal) || 0 } })} />
              </>
            ) : (
              options.map((o) => (
                <Chip
                  key={String(o.value)}
                  label={o.label}
                  active={String(o.value) === String(d.value)}
                  onClick={() => send({ set: { [key]: o.value } })}
                  disabled={busy}
                />
              ))
            )}
            <span className="w-full text-[10px] text-muted-foreground">
              改了只重跑剪辑;字幕和润色烧在剪辑上,会跟着重出。
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function Chip({ label, active, onClick, disabled }: { label: string; active?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || active}
      className={`rounded-full px-2 py-0.5 text-[11px] disabled:cursor-default ${
        active ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-border disabled:opacity-40"
      }`}
    >
      {label}
    </button>
  );
}
