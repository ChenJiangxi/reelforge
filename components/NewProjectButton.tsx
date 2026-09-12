"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState("douyin");
  const [voice, setVoice] = useState("clone-zh");
  const [bgm, setBgm] = useState("none");
  const [duration, setDuration] = useState("75");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const aspect = platform === "bilibili" ? "16:9" : "9:16";

  async function submit() {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/project/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, title, platform, voice, bgm, aspect, duration }),
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

  const selectCls =
    "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/50";

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
      <div className="mb-2 flex flex-col gap-2 sm:flex-row">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可留空，自动取）"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/50"
        />
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={selectCls}>
          <option value="douyin">抖音竖版</option>
          <option value="bilibili">B站横版</option>
        </select>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <select value={voice} onChange={(e) => setVoice(e.target.value)} className={selectCls}>
          <option value="clone-zh">克隆音·中文</option>
          <option value="minimax-en">英文旁白</option>
        </select>
        <select value={bgm} onChange={(e) => setBgm(e.target.value)} className={selectCls}>
          <option value="none">无 BGM</option>
          <option value="yes">带 BGM</option>
        </select>
        <select value={duration} onChange={(e) => setDuration(e.target.value)} className={selectCls}>
          <option value="60">~60 秒</option>
          <option value="75">~75 秒</option>
          <option value="90">~90 秒</option>
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
