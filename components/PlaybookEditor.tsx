"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// 一个教案的编辑器:左边编辑,右边贴这个阶段最近被打回的批注。
export function PlaybookEditor({
  name,
  title,
  desc,
  notes,
  stageLabel,
}: {
  name: string;
  title: string;
  desc: string;
  notes: string[];
  stageLabel: string;
}) {
  const router = useRouter();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch(`/api/playbooks/${name}`)
      .then((r) => r.json())
      .then((d) => setText(d.text ?? ""))
      .catch(() => setErr("教案没加载出来,刷新一下"));
  }, [name]);

  async function save() {
    if (text == null || busy) return;
    setBusy(true);
    setErr("");
    const r = await fetch(`/api/playbooks/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    setBusy(false);
    // 以前不看返回值,保存失败也显示"已保存 ✓",她以为教案改好了,下一条片还是按旧的做
    if (!r?.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      setErr(`没保存上:${d.error ?? (r ? `服务器返回 ${r.status}` : "网络断了")}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr,260px]">
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <div>
            <span className="text-sm font-semibold">{title}</span>
            <span className="ml-2 text-xs text-muted-foreground">{desc}</span>
          </div>
          <button
            onClick={save}
            disabled={busy || text == null}
            className="rounded-full bg-foreground px-4 py-1.5 text-xs font-medium text-background hover:opacity-85 disabled:opacity-40"
          >
            {busy ? "保存中…" : saved ? "已保存 ✓" : "保存"}
          </button>
          {err && <span className="ml-2 text-xs text-destructive">{err}</span>}
        </div>
        {text == null ? (
          <div className="rounded-lg bg-muted/50 p-8 text-center text-sm text-muted-foreground">载入中…</div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-64 w-full resize-none rounded-lg bg-muted/40 p-4 font-mono text-[13px] leading-relaxed outline-none focus:bg-muted/60"
          />
        )}
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          「{stageLabel}」最近被打回的批注
        </div>
        {notes.length === 0 ? (
          <div className="text-xs text-muted-foreground/50">还没有,好迹象。</div>
        ) : (
          <div className="space-y-2">
            {notes.map((n, i) => (
              <div key={i} className="border-l-2 border-destructive/40 pl-2 text-xs leading-relaxed text-muted-foreground">
                {n}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
