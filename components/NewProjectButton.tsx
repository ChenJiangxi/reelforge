"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VOICE_OPTIONS, ASPECT_OPTIONS } from "@/lib/stages";

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [voice, setVoice] = useState("clone-zh");
  const [bgm, setBgm] = useState("none");
  const [duration, setDuration] = useState("75");
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
        body: JSON.stringify({ topic, title, voice, bgm, aspect, duration }),
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

  const fieldCls =
    "w-full rounded-md border border-border bg-card px-3.5 py-2.5 text-sm outline-none focus:border-accent/60";
  const labelCls = "section-label mb-1.5 block";

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="shrink-0 whitespace-nowrap rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-85"
      >
        + 新建项目
      </button>
    );
  }

  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-5 text-base font-semibold">新建项目</div>

      <div className="mb-3">
        <label className={labelCls}>主题 / 角度</label>
        <textarea
          autoFocus
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="一句话说清,比如:年轻人为什么开始信八字"
          rows={3}
          className={`${fieldCls} resize-none`}
        />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>标题(可留空)</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} />
        </div>
        <div>
          <label className={labelCls}>画幅</label>
          <select value={aspect} onChange={(e) => setAspect(e.target.value)} className={fieldCls}>
            {ASPECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>音色</label>
          <select value={voice} onChange={(e) => setVoice(e.target.value)} className={fieldCls}>
            {VOICE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>BGM</label>
            <select value={bgm} onChange={(e) => setBgm(e.target.value)} className={fieldCls}>
              <option value="none">无</option>
              <option value="yes">有</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>时长</label>
            <select value={duration} onChange={(e) => setDuration(e.target.value)} className={fieldCls}>
              <option value="60">~60s</option>
              <option value="75">~75s</option>
              <option value="90">~90s</option>
            </select>
          </div>
        </div>
      </div>

      {err && <div className="mb-3 text-xs text-destructive">{err}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy || !topic.trim()}
          className="rounded-full bg-foreground px-6 py-2.5 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
        >
          {busy ? "创建中…" : "创建"}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          取消
        </button>
      </div>
    </div>
  );
}
