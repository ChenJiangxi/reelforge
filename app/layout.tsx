import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { ProjectNav } from "@/components/ProjectNav";
import { LiveRefresh } from "@/components/LiveRefresh";

export const metadata: Metadata = {
  title: "reelforge",
  description: "内容生产工作台 · agent 干活，你监管",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authed = await isAuthed();
  const projects = authed
    ? await prisma.project.findMany({
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, title: true, status: true },
      })
    : [];

  return (
    <html lang="zh">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {authed && <LiveRefresh />}
        {/* mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border bg-card/90 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/" className="shrink-0 text-[15px] font-bold tracking-tight">
            reel<span className="text-accent">forge</span>
          </Link>
          {authed && <ProjectNav projects={projects} />}
        </header>
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-card p-5 md:flex">
            <Link href="/" className="mb-6 text-[17px] font-bold tracking-tight">
              reel<span className="text-accent">forge</span>
            </Link>
            <div className="section-label mb-2 px-2">工作台</div>
            <nav className="space-y-0.5 text-sm">
              <Link href="/" className="block rounded-md bg-muted px-3 py-2 font-medium">
                全部项目
              </Link>
              <div className="block cursor-default rounded-md px-3 py-2 text-muted-foreground/60">
                数据反馈<span className="ml-1.5 text-[10px]">soon</span>
              </div>
            </nav>
            {authed && <ProjectNav projects={projects} />}
            <div className="mt-4 text-xs leading-relaxed text-muted-foreground">
              <span className="mb-1 flex items-center gap-1.5 text-[11px] text-success">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-success" />
                实时 · 10s 自动刷新
              </span>
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
