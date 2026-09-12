import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "reelforge",
  description: "内容生产工作台 · agent 干活，你监管",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {/* mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-card/90 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="text-[15px] font-bold tracking-tight">
            reel<span className="text-accent">forge</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="text-foreground">
              项目
            </Link>
          </nav>
        </header>
        <div className="flex min-h-screen">
          <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card p-5 md:flex">
            <Link href="/" className="mb-8 text-[17px] font-bold tracking-tight">
              reel<span className="text-accent">forge</span>
            </Link>
            <div className="section-label mb-2 px-2">工作台</div>
            <nav className="space-y-0.5 text-sm">
              <Link href="/" className="block rounded-md bg-muted px-3 py-2 font-medium">
                项目
              </Link>
              <div className="block cursor-default rounded-md px-3 py-2 text-muted-foreground/60">
                数据反馈<span className="ml-1.5 text-[10px]">soon</span>
              </div>
            </nav>
            <div className="mt-auto text-xs leading-relaxed text-muted-foreground">
              抖音优先 · agent 干活
              <br />
              你在关键点审
            </div>
          </aside>
          <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
