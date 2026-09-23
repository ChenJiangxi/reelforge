"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadFiles } from "@/lib/upload-client";

export type Asset = { name: string; url: string; kind: string; size: number; file?: string };

/** 产品页素材的缩略图 = 它的第一张切片 */
export const pageThumb = (url: string) => url.replace(/\.page\.json(\?.*)?$/, ".page-0.png$1");

// 录产品页:填网址 → 渲染机用手机尺寸打开、截整页长图、记下每段字的位置 → 进素材库,
// 分镜里用「产品页」镜头在手机里滚动、推近、划线、光标点(登录过的页面也能录)
function CaptureButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"" | "running" | "done">("");
  const [err, setErr] = useState("");

  async function start() {
    setErr("");
    const r = await fetch(`/api/project/${projectId}/capture`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, name }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.task) return setErr(j.error || `出错了(${r.status})`);
    setState("running");
    setOpen(false);
    const t0 = Date.now();
    for (;;) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = await fetch(`/api/project/${projectId}/capture?task=${j.task}`).then((x) => x.json()).catch(() => ({ status: "?" }));
      if (s.status === "done") {
        setState("done");
        setUrl("");
        setName("");
        router.refresh();
        setTimeout(() => setState(""), 4000);
        return;
      }
      if (s.status === "error" || s.status === "unknown" || Date.now() - t0 > 15 * 60_000) {
        setState("");
        setErr(s.status === "error" ? `录制失败:${s.error}` : s.status === "unknown" ? "任务丢了(服务器可能重启过),再点一次" : "等了 15 分钟还没录完,看看渲染机在不在线");
        return;
      }
    }
  }

  return (
    <span className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={state === "running"}
        title="把产品网页录成素材:手机尺寸整页长图,分镜里可以在手机里滚动、推近、划重点"
        className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-60"
      >
        {state === "running" ? "录制中…(约半分钟)" : state === "done" ? "✓ 录好了" : "+ 录产品页"}
      </button>
      {err && (
        <button onClick={() => setErr("")} title="点一下关掉" className="ml-2 max-w-64 truncate text-xs text-destructive">
          {err}
        </button>
      )}
      {open && (
        <span className="absolute right-0 top-full z-30 mt-1 flex w-80 flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-lg">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="网址,比如 https://auramate.com.cn/report/…"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && url && start()}
            placeholder="起个名字(分镜里这么叫它),比如 正缘报告"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <span className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">要登录的页面,渲染机会用存好的账号自动登录</span>
            <button onClick={start} disabled={!url} className="shrink-0 rounded-full bg-accent px-3 py-1 text-xs text-accent-foreground disabled:opacity-40">
              录
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

// 项目素材库:上传录屏/图片,管线做素材阶段时会挑着用(或聊天里指定)。
export function AssetBar({ projectId, assets, compact = false }: { projectId: string; assets: Asset[]; compact?: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    setBusy(true);
    setErr("");
    const msg = await uploadFiles(`/api/project/${projectId}/assets`, files);
    if (msg) setErr(msg);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  if (compact) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="flex items-center gap-1">
          {assets.slice(0, 6).map((a) =>
            a.kind === "page" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={a.name}
                src={pageThumb(a.url)}
                alt={a.name}
                title={`产品页「${a.name}」:在分镜里选「产品页」镜头使用`}
                className="h-6 w-auto rounded border border-accent/50 object-cover object-top"
              />
            ) : a.kind === "video" ? (
              <span
                key={a.name}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-rf-asset", a.name)}
                title={`拖到下面时间轴的画面轨上插入:${a.name}`}
                className="flex h-6 cursor-grab items-center rounded bg-muted px-1.5 text-[10px] text-foreground/80 hover:ring-1 hover:ring-accent/50"
              >
                🎬
              </span>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={a.name}
                src={a.url}
                alt={a.name}
                title={`拖到下面时间轴的画面轨上插入:${a.name}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-rf-asset", a.name)}
                className="h-6 w-auto cursor-grab rounded border border-border hover:ring-1 hover:ring-accent/50"
              />
            ),
          )}
          {assets.length > 6 && <span className="text-[10px] text-muted-foreground">+{assets.length - 6}</span>}
        </span>
        <span className="text-xs text-muted-foreground">素材库{assets.length > 6 ? `(${assets.length})` : ""}</span>
        <input ref={inputRef} type="file" accept="video/*,image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          {busy ? "上传中…" : "+ 上传"}
        </button>
        <CaptureButton projectId={projectId} />
        {err && (
          <button onClick={() => setErr("")} title="点一下关掉" className="max-w-64 truncate text-xs text-destructive">
            {err}
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">素材库</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {assets.map((a) =>
          a.kind === "page" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={a.name} src={pageThumb(a.url)} alt={a.name} title={`产品页「${a.name}」`} className="h-8 w-auto shrink-0 rounded border border-accent/50 object-cover object-top" />
          ) : a.kind === "video" ? (
            <span
              key={a.name}
              title={a.name}
              className="flex shrink-0 items-center gap-1 rounded bg-muted px-2 py-1 text-xs text-foreground/80"
            >
              🎬 {a.name}
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a.name}
              src={a.url}
              alt={a.name}
              title={a.name}
              className="h-8 w-auto shrink-0 rounded border border-border object-cover"
            />
          ),
        )}
        {assets.length === 0 && (
          <span className="text-xs text-muted-foreground/60">
            上传产品录屏/实拍图——真素材永远比字卡好,素材阶段会挑着用
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*"
        multiple
        className="hidden"
        onChange={(e) => upload(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
      >
        {busy ? "上传中…" : "+ 上传"}
      </button>
      <CaptureButton projectId={projectId} />
      {err && <span className="shrink-0 text-xs text-destructive">{err}</span>}
    </div>
  );
}
