const COLOR: Record<string, string> = {
  producing: "text-blue-400",
  reviewing: "text-accent",
  approved: "text-green-400",
  delivered: "text-purple-400",
  pending: "text-foreground/30",
  working: "text-blue-400",
  awaiting_review: "text-accent",
  changes_requested: "text-red-400",
};

const LABEL: Record<string, string> = {
  producing: "制作中",
  reviewing: "待审",
  approved: "已通过",
  delivered: "已交付",
  pending: "待办",
  working: "进行中",
  awaiting_review: "待审",
  changes_requested: "打回",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-xs font-medium ${COLOR[status] ?? "text-foreground/40"}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
