"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type Asset = { name: string; url: string; kind: string; size: number };

// 项目素材库:上传录屏/图片,管线做素材阶段时会挑着用(或聊天里指定)。
export function AssetBar({ projectId, assets, compact = false }: { projectId: string; assets: Asset[]; compact?: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    setBusy(true);
    const form = new FormData();
    for (const f of files) form.append("files", f);
    try {
      await fetch(`/api/project/${projectId}/assets`, { method: "POST", body: form });
      router.refresh();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  if (compact) {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground">素材库 {assets.length > 0 ? `(${assets.length})` : ""}</span>
        <input ref={inputRef} type="file" accept="video/*,image/*" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
        >
          {busy ? "上传中…" : "+ 上传"}
        </button>
      </span>
    );
  }

  return (
    <div className="mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">素材库</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {assets.map((a) =>
          a.kind === "video" ? (
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
    </div>
  );
}
