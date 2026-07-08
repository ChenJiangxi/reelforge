import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "reelforge",
  description: "内容生产监管台 · agent 干活，你监管",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-border bg-card p-4">
            <div className="mb-6 text-lg font-bold tracking-tight">
              reel<span className="text-accent">forge</span>
            </div>
            <nav className="space-y-1 text-sm">
              <Link href="/" className="block rounded px-3 py-2 hover:bg-muted">
                📋 项目
              </Link>
              <div className="block rounded px-3 py-2 text-foreground/30">🎬 管线（soon）</div>
              <div className="block rounded px-3 py-2 text-foreground/30">📊 流量（soon）</div>
            </nav>
            <div className="mt-8 text-xs leading-relaxed text-foreground/30">
              抖音优先 · agent 干活 · 你在关键点审
            </div>
          </aside>
          <main className="flex-1 p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
