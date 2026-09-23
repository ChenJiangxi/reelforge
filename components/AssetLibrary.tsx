"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadFiles } from "@/lib/upload-client";

type Asset = { name: string; url: string; kind: string; size: number };

function fmtSize(n: number) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

export function AssetLibrary({ assets }: { assets: Asset[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    setBusy(true);
    setErr("");
    const msg = await uploadFiles("/api/assets", files);
    if (msg) setErr(msg);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div>
      <div className="mb-4">
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
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
        >
          {busy ? "上传中…" : "+ 上传素材"}
        </button>
        {err && <span className="ml-3 text-xs text-destructive">{err}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a) => (
          <div key={a.name} className="overflow-hidden rounded-lg bg-muted/40">
            {a.kind === "page" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.url.replace(/\.page\.json(\?.*)?$/, ".page-0.png$1")} alt={a.name} className="aspect-video w-full object-cover object-top" />
            ) : a.kind === "video" ? (
              <video src={a.url} controls preload="metadata" className="aspect-video w-full bg-black object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={a.url} alt={a.name} className="aspect-video w-full object-cover" />
            )}
            <div className="flex items-center justify-between gap-2 px-2.5 py-2">
              <span className="truncate text-xs" title={a.name}>
                {a.kind === "video" ? "🎬 " : a.kind === "page" ? "📱 " : ""}
                {a.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtSize(a.size)}</span>
            </div>
          </div>
        ))}
        {assets.length === 0 && (
          <div className="col-span-full rounded-lg bg-muted/40 px-6 py-16 text-center">
            <div className="mb-1 text-sm font-medium">素材库是空的</div>
            <div className="text-sm text-muted-foreground">
              传产品录屏、实拍图、封面图——素材阶段会按内容自动挑用。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
