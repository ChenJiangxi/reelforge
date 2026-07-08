"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState("douyin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/project/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, title, platform }),
      });
      const d = await r.json();
      if (r.ok && d.id) {
        router.push(`/project/${d.id}`);
        return;
      }
      setErr(d.error ?? "创建失败");
    } catch {
      setErr("网络错误");
    }
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/20"
      >
        + 新建项目
      </button>
    );
  }

  return (
    <div className="w-full max-w-xl rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-sm font-semibold">新建项目</div>
      <textarea
        autoFocus
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="你想做个什么视频？一句话说清主题 / 角度，比如：年轻人为什么开始信八字"
        rows={3}
        className="mb-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/50"
      />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可留空，自动取）"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/50"
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/50"
        >
          <option value="douyin">抖音</option>
          <option value="bilibili">B站</option>
          <option value="xiaohongshu">小红书</option>
        </select>
      </div>
      {err && <div className="mb-2 text-xs text-red-400">{err}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !topic.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "创建中…" : "创建"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-2 text-sm text-foreground/50 transition hover:text-foreground"
        >
          取消
        </button>
      </div>
    </div>
  );
}
