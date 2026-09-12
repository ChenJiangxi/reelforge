"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    setErr("");
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (r.ok) {
      router.push(params.get("next") || "/");
      router.refresh();
      return;
    }
    setErr("口令不对");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="w-full max-w-xs rounded-xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 text-lg font-bold tracking-tight">
        reel<span className="text-accent">forge</span>
      </div>
      <input
        type="password"
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="访问口令"
        className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
      {err && <div className="mb-2 text-xs text-destructive">{err}</div>}
      <button
        type="submit"
        disabled={busy || !code}
        className="w-full rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-85 disabled:opacity-40"
      >
        进入
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
