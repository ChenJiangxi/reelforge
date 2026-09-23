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

// 谁真的依赖谁 —— 一张表,打回、聊天改稿、拖素材、换配音、参数覆盖全走它(lib/rerun.ts)。
// hard = 下游产物里直接嵌着上游的产出(音轨烧进成片、字幕烧在粗剪上),上游一变它必然作废,
//        界面上锁死不能取消;
// soft = 下游只是"参考过"上游(封面文案参考脚本、画面按台词设计),上游变了它可能还能用,
//        默认跟着重出,她可以取消。
// 配音只吃脚本,不吃画面:换素材、重剪、改运镜都不该让配音重做(Jessy 2026-09-16)。
// 润色 → 交付没有边:交付的封面/文案不看成片,打包时自动取最新成片(resolveStage 里重新打包)。
export type Dep = { from: string; to: string; hard: boolean; why: string };
export const DEPS: readonly Dep[] = [
  { from: "topic", to: "script", hard: false, why: "脚本是按选题写的;选题只改了措辞,脚本可以留着" },
  { from: "topic", to: "deliver", hard: false, why: "封面和文案参考了选题" },
  { from: "script", to: "footage", hard: false, why: "每拍画面按台词设计;台词没变的拍会沿用原设计" },
  { from: "script", to: "voice", hard: true, why: "配音念的就是脚本" },
  { from: "script", to: "deliver", hard: false, why: "文案是按脚本写的" },
  { from: "footage", to: "edit", hard: true, why: "剪辑用的就是这批画面" },
  { from: "voice", to: "edit", hard: true, why: "成片的音轨就是这版配音" },
  { from: "voice", to: "subtitles", hard: true, why: "字幕的时间轴来自配音" },
  { from: "edit", to: "subtitles", hard: true, why: "字幕烧在剪辑出来的视频上" },
  { from: "subtitles", to: "polish", hard: true, why: "体检查的就是带字幕的成片" },
];

export type PlanRow = {
  kind: string;
  /** redo = 这次要重做的阶段本身;changed = 产物已经被她直接改了(比如亲手改稿),只重跑下游;
   *  hard = 锁死,必须跟着重出;soft = 默认跟着重出,可以取消;skipped = 她取消了的 soft;
   *  untouched = 不受影响 */
  state: "redo" | "changed" | "hard" | "soft" | "skipped" | "untouched";
  why: string;
  /** 这个阶段本来就在排队/还没做过 —— 勾不勾都会做,表单里不给开关 */
  queued?: boolean;
};

// 打回/改稿之后哪些阶段要重跑。按 STAGE_ORDER 往下走一遍:一个阶段只要有一条 hard 边
// 连着"这次会变"的上游,就锁死;只有 soft 边,就看她取没取消。
// beatCountChanged:拍数变了,每拍一张的画面就不可能沿用,脚本 → 素材升级成 hard。
export function planRerun(
  opts: { redo?: string[]; changed?: string[]; skip?: string[]; beatCountChanged?: boolean },
  statuses: Record<string, string> = {},
): PlanRow[] {
  const redo = new Set(opts.redo ?? []);
  const changed = new Set(opts.changed ?? []);
  const skip = new Set(opts.skip ?? []);
  const active = new Set<string>([...redo, ...changed]);
  const rows: PlanRow[] = [];
  for (const k of STAGE_ORDER) {
    const queued = statuses[k] != null && statuses[k] !== "approved";
    if (redo.has(k)) { rows.push({ kind: k, state: "redo", why: "这次要重做的就是它" }); continue; }
    if (changed.has(k)) { rows.push({ kind: k, state: "changed", why: "你已经直接改了它" }); continue; }
    const incoming = DEPS.filter((d) => d.to === k && active.has(d.from));
    if (!incoming.length) {
      const inputs = DEPS.filter((d) => d.to === k).map((d) => stageLabel(d.from));
      rows.push({ kind: k, state: "untouched", queued, why: inputs.length ? `它只看「${inputs.join("」「")}」` : "它不依赖别的阶段" });
      continue;
    }
    const hardEdge = incoming.find((d) => d.hard || (opts.beatCountChanged && d.from === "script" && d.to === "footage"));
    if (hardEdge) {
      const why = hardEdge.hard ? hardEdge.why : "拍数变了,每拍一张的画面没法沿用";
      rows.push({ kind: k, state: "hard", why, queued });
      active.add(k);
    } else if (skip.has(k) && !queued) {
      rows.push({ kind: k, state: "skipped", why: incoming.map((d) => d.why).join(";") });
    } else {
      rows.push({ kind: k, state: "soft", why: incoming.map((d) => d.why).join(";"), queued });
      active.add(k);
    }
  }
  return rows;
}

/** 计划里真正要置回 pending 的阶段(不含 redo/changed 本身) */
export function rerunKinds(rows: PlanRow[]): string[] {
  return rows.filter((r) => r.state === "hard" || r.state === "soft").map((r) => r.kind);
}

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
export type VoiceMeta = {
  /** 这一版每拍音频文件的文件名后缀(A 版空字符串,B 版 "-b")—— 整段一次合成后
   * 每拍从同一份音频里切出来,ensureInputs 靠它找到对应文件,不重新调 TTS。 */
  tag?: string;
  clips: {
    name: string; beat?: string; text: string; tts?: string; dur: number; gap?: number;
    /** 这拍音频前面被裁掉的空白(秒) —— 拼接时要从这儿开始截 */
    head?: number;
    /** MiniMax 字级时间戳 [字, 开始ms, 结束ms] —— 字幕按它对齐 */
    words?: [string, number, number][];
    say?: { speed: number; speedRel?: number; pitch: number; emotion: string | null; gap_after?: number };
  }[];
  gap?: number;
};

export type Artifacts = {
  video?: string;
  audio?: string;
  wave?: string;
  script?: string;
  cover?: string;
  note?: string;
  caption?: { title: string; hashtags: string[]; desc: string };
  images?: string[];
  clips?: { name: string; text: string; visual?: string; asset?: string; overrides?: Overrides }[];
  cards?: {
    name: string; text?: string; type?: string; kicker?: string; big?: string; sub?: string; foot?: string;
    anim?: string; asset?: string; visualRev?: number;
  }[];
  /** 配音的两版念法 —— 她听完点一个(见 /api/project/[id]/voice-take) */
  takes?: {
    a: { label: string; audio: string; wave?: string; total?: number };
    b: { label: string; audio: string; wave?: string; total?: number };
    picked?: "a" | "b";
  };
  voiceMetaAlt?: VoiceMeta;
  voiceMeta?: VoiceMeta;
  subs?: { text: string; start: number; end: number }[];
  topic?: { angle?: string; hook?: string; claims?: string[]; avoid?: string[]; title?: string };
  decisions?: Decision[];
  failure?: Failure;
};

/** 阶段的事件记录。decision: approve | comment | reject(她写的批注,worker 照着改)
 *  | queued(被上游连带着排队重出,text 说明因为谁)| failed(worker 没做成,text 是原因) */
export type Comment = { ts: number; text: string; decision: string };

/** 每个阶段产出时同时交一份"这一步替你做了哪些决定"。beat 为空 = 整个阶段的决定。
 *  key 有值 = 这条决定可以被她的参数覆盖改掉(见 Overrides),value 是这次实际用的值。 */
export type Decision = {
  beat?: string;
  topic: string;
  choice: string;
  why?: string;
  by?: "auto" | "you";
  key?: keyof Overrides | "sfx";
  value?: string | number;
  warn?: boolean;
};

/** 挂在某一拍上的剪辑参数覆盖 —— 存在脚本阶段的 clips[i].overrides 里,跟着这一拍走
 *  (插句删句重新编号也不丢),持久、可见、能撤销。只影响剪辑阶段。 */
export type Overrides = {
  /** 进画:contain 整幅放进去(模糊底)/ cover 铺满裁切 */
  fit?: "contain" | "cover";
  /** 素材播放拉伸倍数:1.5 = 放慢到 1.5 倍长;0.75 = 加速 */
  slow?: number;
  /** 素材放慢后还不够这一拍长时怎么补:正倒放接龙 / 冻最后一帧 / 硬循环 */
  fill?: "pingpong" | "freeze" | "loop";
  /** 从素材第几秒开始用 */
  from?: number;
  /** 运镜(见 CAMERA_LABELS),none = 不加运镜,focus = 录屏跟着台词对焦 */
  camera?: string;
  /** 这一拍画成手绘图解(on)或不画(off);不设 = 默认前两个关系图/流程卡画 */
  draw?: "on" | "off";
};

/** 整条片的剪辑设置(存在脚本阶段 artifacts.editSettings) */
export type EditSettings = { sfx?: "on" | "off" };

export const OVERRIDE_LABELS: Record<keyof Overrides, string> = {
  fit: "进画",
  slow: "速度",
  fill: "不够长时",
  from: "起点",
  camera: "运镜",
  draw: "手绘",
};
export const DRAW_LABELS: Record<string, string> = { on: "画成手绘", off: "不手绘" };

export const FIT_LABELS: Record<string, string> = { contain: "整幅放进去", cover: "铺满裁切" };
export const FILL_LABELS: Record<string, string> = { pingpong: "正倒放接龙", freeze: "冻最后一帧", loop: "硬循环" };
export const CAMERA_LABELS: Record<string, string> = {
  none: "不加运镜",
  focus: "跟着台词对焦",
  pushIn: "推近",
  pushSoft: "轻推",
  pullOut: "拉远",
  panRight: "右摇",
  panLeft: "左摇",
  driftUp: "上移",
  hold: "几乎不动",
  pullSoft: "轻拉",
  pushMicro: "微推",
};
/** 每种画面能用的运镜(和 worker/stages.mjs 的 CAM_MOVES / CAM_ANIM 对应) */
export const CAMERA_CHOICES: Record<string, string[]> = {
  image: ["focus", "pushIn", "pushSoft", "pullOut", "panRight", "panLeft", "driftUp", "hold", "none"],
  card: ["pushIn", "pushSoft", "pullOut", "panRight", "panLeft", "driftUp", "hold", "none"],
  anim: ["pushSoft", "pullSoft", "pushMicro", "none"],
  video: ["focus", "none", "pushSoft", "pullSoft", "pushMicro"],
};

export function describeOverride(key: keyof Overrides, v: unknown): string {
  if (key === "fit") return FIT_LABELS[String(v)] ?? String(v);
  if (key === "fill") return FILL_LABELS[String(v)] ?? String(v);
  if (key === "camera") return CAMERA_LABELS[String(v)] ?? String(v);
  if (key === "draw") return DRAW_LABELS[String(v)] ?? String(v);
  if (key === "slow") {
    const n = Number(v);
    return Math.abs(n - 1) < 0.01 ? "原速" : n > 1 ? `放慢到 ${n.toFixed(2)} 倍长` : `加速 ${(1 / n).toFixed(2)}x`;
  }
  if (key === "from") return `从第 ${Number(v).toFixed(1)} 秒开始`;
  return String(v);
}

/** worker 失败时交的结构化原因:失败在哪一拍、哪一步 */
export type Failure = {
  stage: string; beat?: string; step?: string; message: string; kind?: "disk" | "timeout" | "error"; ts: number;
  /** 失败那次正在处理的打回批注 —— 重试时接着处理 */
  note?: string;
};
