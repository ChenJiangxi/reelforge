export const STAGE_ORDER = [
  "topic",
  "script",
  "footage",
  "voice",
  "edit",
  "subtitles",
  "polish",
  "deliver",
] as const;

export const STAGE_LABELS: Record<string, string> = {
  topic: "选题",
  script: "脚本",
  footage: "素材",
  voice: "配音",
  edit: "剪辑",
  subtitles: "字幕",
  polish: "润色",
  deliver: "交付",
};

export function stageLabel(k: string): string {
  return STAGE_LABELS[k] ?? k;
}

export type Artifacts = {
  video?: string;
  script?: string;
  cover?: string;
  note?: string;
  caption?: { title: string; hashtags: string[]; desc: string };
  images?: string[];
};

export type Comment = { ts: number; text: string; decision: string };
