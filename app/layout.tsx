import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { LiveRefresh } from "@/components/LiveRefresh";
import { AppShell } from "@/components/AppShell";
import { ProjectNav } from "@/components/ProjectNav";

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
        <AppShell authed={authed} projects={projects}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
