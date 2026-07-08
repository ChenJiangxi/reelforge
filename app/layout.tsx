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
        {/* mobile top bar (sidebar collapses into this on small screens) */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-card/95 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="text-lg font-bold tracking-tight">
            reel<span className="text-accent">forge</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-foreground/80">
              项目
            </Link>
            <span className="text-foreground/25">管线</span>
            <span className="text-foreground/25">流量</span>
          </nav>
        </header>
        <div className="flex min-h-screen">
          <aside className="hidden w-56 shrink-0 border-r border-border bg-card p-4 md:block">
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
          <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
