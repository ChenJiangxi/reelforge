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

// 音色与画幅选项(worker 侧 VOICES 表同步)
export const VOICE_OPTIONS = [
  { value: "clone-zh", label: "克隆音·Jessy（中文）" },
  { value: "presenter-male", label: "中文男声·主播" },
  { value: "audiobook-male", label: "中文男声·有声书" },
  { value: "female-tianmei", label: "中文女声·甜美" },
  { value: "female-shaonv", label: "中文女声·少女" },
  { value: "minimax-en", label: "英文旁白·expressive" },
];

export const ASPECT_OPTIONS = [
  { value: "9:16", label: "竖版 9:16（抖音）", platform: "douyin" },
  { value: "3:4", label: "竖版 3:4（小红书）", platform: "xiaohongshu" },
  { value: "16:9", label: "横版 16:9（B站）", platform: "bilibili" },
];

export function voiceLabel(v: string): string {
  return VOICE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}

export function platformForAspect(aspect: string): string {
  return ASPECT_OPTIONS.find((o) => o.value === aspect)?.platform ?? "douyin";
}

// Media fields hold /api/media/<projectId>/<file> URLs served from MEDIA_DIR.
export type Artifacts = {
  video?: string;
  audio?: string;
  wave?: string;
  script?: string;
  cover?: string;
  note?: string;
  caption?: { title: string; hashtags: string[]; desc: string };
  images?: string[];
  clips?: { name: string; text: string; visual?: string }[];
  cards?: { name: string; text?: string; type?: string; kicker?: string; big?: string; sub?: string; foot?: string }[];
  voiceMeta?: {
    clips: {
      name: string; beat?: string; text: string; tts?: string; dur: number; gap?: number;
      /** MiniMax 字级时间戳 [字, 开始ms, 结束ms] —— 字幕按它对齐 */
      words?: [string, number, number][];
      say?: { speed: number; speedRel?: number; pitch: number; emotion: string | null; gap_after?: number };
    }[];
    gap?: number;
  };
  subs?: { text: string; start: number; end: number }[];
  topic?: { angle?: string; hook?: string; claims?: string[]; avoid?: string[]; title?: string };
};

export type Comment = { ts: number; text: string; decision: string };
