"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { stageLabel, type Artifacts, type Comment } from "@/lib/stages";
import { StatusBadge } from "./StatusBadge";

type StageDTO = {
  id: string;
  kind: string;
  order: number;
  status: string;
  artifacts: string | null;
  comments: string | null;
};

export function StageCard({ stage, projectId }: { stage: StageDTO; projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [err, setErr] = useState("");
  const art: Artifacts = stage.artifacts ? JSON.parse(stage.artifacts) : {};
  const comments: Comment[] = stage.comments ? JSON.parse(stage.comments) : [];
  const awaiting = stage.status === "awaiting_review";

  async function resolve(decision: "approve" | "comment" | "reject") {
    if (decision === "comment" && !comment.trim()) return;
    if (decision === "reject" && !comment.trim()) {
      setErr("打回要写一句原因，agent 照着改");
      return;
    }
    setErr("");
    setBusy(true);
    await fetch("/api/stage/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageId: stage.id, decision, text: comment.trim() || undefined }),
    });
    setBusy(false);
    setComment("");
    router.refresh();
  }

  return (
    <div className={`rounded-xl border p-4 ${awaiting ? "border-accent/60 bg-accent/5" : "border-border bg-card"}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="font-semibold">{stageLabel(stage.kind)}</span>
        <StatusBadge status={stage.status} />
      </div>

      {art.video && (
        <video controls className="mt-2 w-full max-w-sm rounded-lg border border-border" src={art.video} />
      )}
      {art.audio && (
        <audio controls className="mt-2 w-full max-w-sm" src={art.audio} />
      )}
      {art.script && (
        <pre className="mt-2 whitespace-pre-wrap rounded bg-muted p-3 text-sm text-foreground/80">{art.script}</pre>
      )}
      {art.cover && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt="cover"
          src={art.cover}
          className={`mt-2 rounded-lg border border-border ${stage.kind === "deliver" ? "w-40" : "w-full max-w-xs"}`}
        />
      )}
      {art.images && art.images.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {art.images.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              alt={`素材 ${i + 1}`}
              src={src}
              className="w-full rounded-lg border border-border"
            />
          ))}
        </div>
      )}
      {art.caption && (
        <div className="mt-2 rounded bg-muted p-3 text-sm">
          <div className="font-medium">{art.caption.title}</div>
          <div className="mt-1 text-accent">{art.caption.hashtags.join(" ")}</div>
          <div className="mt-1 text-foreground/60">{art.caption.desc}</div>
        </div>
      )}
      {art.note && <p className="mt-2 text-sm text-foreground/60">{art.note}</p>}

      {comments.length > 0 && (
        <div className="mt-3 space-y-1 text-xs text-foreground/60">
          {comments.map((c, i) => (
            <div key={i}>
              💬 {c.text} <span className="text-foreground/30">({c.decision})</span>
            </div>
          ))}
        </div>
      )}

      {awaiting && (
        <div className="mt-4 border-t border-accent/20 pt-3">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="批注（可指到具体某句/某段）…"
            rows={2}
            className="mb-2 w-full rounded border border-border bg-background p-2 text-sm outline-none focus:border-accent/50"
          />
          {err && <div className="mb-2 text-xs text-red-400">{err}</div>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => resolve("approve")}
              className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-black disabled:opacity-50"
            >
              通过
            </button>
            <button
              disabled={busy}
              onClick={() => resolve("comment")}
              className="rounded border border-border px-4 py-1.5 text-sm disabled:opacity-50"
            >
              批注
            </button>
            <button
              disabled={busy}
              onClick={() => resolve("reject")}
              className="rounded border border-red-500/40 px-4 py-1.5 text-sm text-red-400 disabled:opacity-50"
            >
              打回
            </button>
          </div>
        </div>
      )}

      {stage.kind === "deliver" && art.caption && (
        <div className="mt-3">
          <a
            href={`/api/download/${projectId}`}
            className="inline-block rounded border border-accent/50 px-3 py-1.5 text-sm text-accent hover:bg-accent/10"
          >
            ⬇ 下载打包（视频 + 封面 + 文案）
          </a>
        </div>
      )}
    </div>
  );
}
