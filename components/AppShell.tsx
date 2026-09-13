"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ProjectNav, type NavProject } from "@/components/ProjectNav";

// App shell with a collapsible left rail (收进去 = 细条图标轨,展开回全宽)。
// Collapsed state persists in localStorage.
export function AppShell({
  authed,
  projects,
  children,
}: {
  authed: boolean;
  projects: NavProject[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("rf_sidebar") === "1");
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem("rf_sidebar", c ? "0" : "1");
      return !c;
    });
  };

  return (
    <div className="flex min-h-screen">
      <aside
        className={`sticky top-0 hidden shrink-0 flex-col border-r border-border bg-card transition-[width,padding] duration-200 md:flex ${
          collapsed ? "w-12 items-center p-2" : "w-60 p-5"
        }`}
      >
        <div className={`flex items-center ${collapsed ? "flex-col gap-3" : "justify-between"}`}>
          <Link href="/" className={`shrink-0 font-bold tracking-tight ${collapsed ? "text-sm" : "text-lg"}`}>
            {collapsed ? (
              <span className="text-accent">r</span>
            ) : (
              <>
                reel<span className="text-accent">forge</span>
              </>
            )}
          </Link>
          <button
            onClick={toggle}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        {collapsed ? (
          <nav className="mt-8 flex flex-col items-center gap-3 text-sm">
            <Link href="/" title="全部项目" className="rounded-md p-2 hover:bg-muted">📋</Link>
            <Link href="/assets" title="素材库" className="rounded-md p-2 hover:bg-muted">🖼</Link>
            <Link href="/playbooks" title="教案" className="rounded-md p-2 hover:bg-muted">📖</Link>
          </nav>
        ) : (
          <>
            <div className="section-label mb-2 mt-6 px-2">工作台</div>
            <nav className="space-y-0.5 text-sm">
              <Link href="/" className="block rounded-md bg-muted px-3 py-2.5 font-medium">
                全部项目
              </Link>
              <Link href="/assets" className="block rounded-md px-3 py-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                素材库
              </Link>
              <Link href="/playbooks" className="block rounded-md px-3 py-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                教案
              </Link>
              <div className="block cursor-default rounded-md px-3 py-2.5 text-muted-foreground/60">
                数据反馈<span className="ml-1.5 text-[10px]">soon</span>
              </div>
            </nav>
            {authed && <ProjectNav projects={projects} />}
          </>
        )}

        {!collapsed && (
          <div className="mt-4 text-xs leading-relaxed text-muted-foreground">
            <span className="mb-1 flex items-center gap-1.5 text-[11px] text-success">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-success" />
              实时 · 10s 自动刷新
            </span>
            抖音优先 · agent 干活
            <br />
            你在关键点审
          </div>
        )}
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}
