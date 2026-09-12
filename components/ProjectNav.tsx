"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export type NavProject = { id: string; title: string; status: string };

const DOT: Record<string, string> = {
  producing: "bg-accent",
  working: "bg-accent",
  reviewing: "bg-accent",
  approved: "bg-success",
  delivered: "bg-success",
};

// Sidebar project list — switch between projects anywhere, run several in
// parallel. Active project highlighted by path.
export function ProjectNav({ projects }: { projects: NavProject[] }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <>
      {/* desktop sidebar list */}
      <div className="mt-6 hidden min-h-0 flex-1 flex-col md:flex">
        <div className="section-label mb-2 flex items-center justify-between px-2">
          <span>项目</span>
          <span className="font-mono tabular-nums">{projects.length}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {projects.map((p) => {
            const active = pathname === `/project/${p.id}`;
            return (
              <Link
                key={p.id}
                href={`/project/${p.id}`}
                className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px] leading-snug ${
                  active ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span className={`mt-1.5 inline-block size-1.5 shrink-0 rounded-full ${DOT[p.status] ?? "bg-border"}`} />
                <span className="line-clamp-2">{p.title}</span>
              </Link>
            );
          })}
          {projects.length === 0 && (
            <div className="px-2 text-xs text-muted-foreground/60">还没有项目</div>
          )}
        </div>
      </div>

      {/* mobile: native select in the top bar */}
      <select
        aria-label="切换项目"
        className="max-w-36 rounded-md border border-border bg-card px-2 py-1 text-sm md:hidden"
        value={pathname.startsWith("/project/") ? pathname.split("/")[2] : ""}
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/project/${v}` : "/");
        }}
      >
        <option value="">全部项目</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title.slice(0, 14)}
          </option>
        ))}
      </select>
    </>
  );
}
