// Status = small dot + label (hermit idiom), not a colored pill.
const STYLE: Record<string, { dot: string; label: string; text?: string }> = {
  producing: { dot: "bg-accent animate-pulse", label: "制作中", text: "text-accent" },
  working: { dot: "bg-accent animate-pulse", label: "进行中", text: "text-accent" },
  reviewing: { dot: "bg-accent", label: "待你审", text: "text-accent" },
  awaiting_review: { dot: "bg-accent", label: "待你审", text: "text-accent" },
  approved: { dot: "bg-success", label: "已通过", text: "text-success" },
  delivered: { dot: "bg-success", label: "已交付", text: "text-success" },
  changes_requested: { dot: "bg-destructive", label: "打回", text: "text-destructive" },
  pending: { dot: "border border-muted-foreground/50", label: "待办", text: "text-muted-foreground" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STYLE[status] ?? { dot: "bg-muted-foreground", label: status, text: "text-muted-foreground" };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className={`inline-block size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
