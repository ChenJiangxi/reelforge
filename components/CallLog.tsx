"use client";

import { useEffect, useState } from "react";

type Row = {
  id: string;
  ts: number;
  stage?: string;
  beat?: string;
  step?: string;
  kind: string;
  model?: string;
  repair?: number;
  status?: string;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
  validation?: string[];
  requestChars?: number;
  responseChars?: number;
};
type Full = Row & {
  request?: { messages?: { role: string; content: string }[]; text?: string; params?: unknown };
  response?: string;
  usage?: unknown;
};

const KIND: Record<string, string> = { llm: "写字", vision: "看图", tts: "配音" };
const STATUS: Record<string, { text: string; cls: string }> = {
  ok: { text: "成功", cls: "text-success" },
  invalid: { text: "没过校验", cls: "text-accent" },
  error: { text: "失败", cls: "text-destructive" },
};

function hhmm(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

// 这一步的每一次模型调用(学 MuseDock 的 API 调用记录):问了什么、回了什么、校验过没过、是不是补正。
// 她问"它为什么写成这样"时,答案就在原始返回里。
export function CallLog({ projectId, stage, onClose }: { projectId: string; stage: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Full | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/project/${projectId}/calls?stage=${encodeURIComponent(stage)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`服务器返回 ${r.status}`);
        return r.json();
      })
      .then((d) => alive && setRows(d))
      .catch((e) => alive && setErr(`调用记录没加载出来:${e.message}`));
    return () => {
      alive = false;
    };
  }, [projectId, stage]);

  async function show(id: string) {
    setLoadingId(id);
    const r = await fetch(`/api/project/${projectId}/calls?id=${id}`).catch(() => null);
    setLoadingId(null);
    if (!r?.ok) {
      setErr("这条记录的详情没取到");
      return;
    }
    setOpen(await r.json());
  }

  return (
    <div className="flex h-full min-h-[40vh] flex-col text-xs">
      <div className="flex shrink-0 items-baseline gap-2 border-b border-border/70 px-3 py-2">
        <span className="text-sm font-medium">调用记录</span>
        <span className="text-muted-foreground">这一步每次问模型 / 配音的原始请求和返回</span>
        <button onClick={open ? () => setOpen(null) : onClose} className="ml-auto text-muted-foreground hover:text-foreground">
          {open ? "← 回列表" : "关闭"}
        </button>
      </div>
      {err && <div className="px-3 py-2 text-destructive">{err}</div>}
      {!open && rows === null && !err && <div className="px-3 py-3 text-muted-foreground">正在加载调用记录…</div>}
      {!open && rows?.length === 0 && (
        <div className="px-3 py-3 leading-relaxed text-muted-foreground">
          这一步还没有调用记录。记录是 09-23 起才开始留的,之前跑的阶段没有;重出一次就有了。
        </div>
      )}
      {!open && rows && rows.length > 0 && (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
          {rows.map((r) => {
            const st = STATUS[r.status ?? ""] ?? { text: r.status ?? "?", cls: "text-muted-foreground" };
            return (
              <button key={r.id} onClick={() => show(r.id)} className="block w-full px-3 py-1.5 text-left hover:bg-muted/60">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{hhmm(r.ts)}</span>
                  <span className="shrink-0">{KIND[r.kind] ?? r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/85">
                    {[r.beat, r.step].filter(Boolean).join(" · ") || "—"}
                    {r.repair ? <span className="ml-1.5 text-accent">补正</span> : null}
                  </span>
                  <span className={`shrink-0 ${st.cls}`}>{st.text}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : ""}
                  </span>
                  {loadingId === r.id && <span className="shrink-0 text-muted-foreground">…</span>}
                </div>
                {(r.validation?.length || r.error) && (
                  <div className="mt-0.5 truncate pl-[4.6rem] text-[11px] text-muted-foreground">{r.error || r.validation?.join(";")}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
      {open && <CallDetail rec={open} />}
    </div>
  );
}

function CallDetail({ rec }: { rec: Full }) {
  const [copied, setCopied] = useState("");
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("复制失败,手动选中复制");
    }
  };
  const reqText = rec.request?.messages
    ? rec.request.messages.map((m) => `【${m.role}】\n${m.content}`).join("\n\n")
    : rec.request?.text ?? "";
  const st = STATUS[rec.status ?? ""]?.text ?? rec.status;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <div className="mb-2 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-0.5">
        <span className="text-muted-foreground">时间</span><span>{hhmm(rec.ts)}</span>
        <span className="text-muted-foreground">哪一步</span><span>{[rec.stage, rec.beat, rec.step].filter(Boolean).join(" · ")}{rec.repair ? " · 补正" : ""}</span>
        <span className="text-muted-foreground">模型</span><span className="font-mono">{rec.model}</span>
        <span className="text-muted-foreground">结果</span>
        <span>{st}{rec.httpStatus ? ` · HTTP ${rec.httpStatus}` : ""}{rec.durationMs != null ? ` · ${(rec.durationMs / 1000).toFixed(1)}s` : ""}</span>
        {rec.validation?.length ? (<><span className="text-muted-foreground">问题</span><span className="text-accent">{rec.validation.join(";")}</span></>) : null}
        {rec.error ? (<><span className="text-muted-foreground">报错</span><span className="text-destructive">{rec.error}</span></>) : null}
      </div>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">返回</span>
        <button onClick={() => copy("返回", rec.response ?? "")} className="text-muted-foreground hover:text-foreground">复制</button>
        {copied && <span className="text-success">{copied === "复制失败,手动选中复制" ? copied : `已复制${copied}`}</span>}
      </div>
      <pre className="mb-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">{rec.response || "(空)"}</pre>
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium">请求</span>
        <button onClick={() => copy("请求", reqText)} className="text-muted-foreground hover:text-foreground">复制</button>
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">{reqText || "(没记)"}</pre>
    </div>
  );
}
