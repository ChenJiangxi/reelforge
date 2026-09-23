// 直通车:她说「c01 别裁,慢一点」,不经过 LLM,直接变成挂在那一拍上的剪辑参数覆盖。
// 只认一小撮说法(进画/速度/补足方式/起点/运镜/恢复默认),认不出的原样告诉她没动 ——
// 宁可少认,不许猜错。纯函数,前后端都能用。
import { CAMERA_CHOICES, type Overrides } from "@/lib/stages";

export type BeatKind = "video" | "image" | "anim" | "card";
export type OverrideChange = { clip: string; set?: Overrides; unset?: (keyof Overrides)[] | "all" };
export type DirectParse = {
  changes: OverrideChange[];
  /** 认出来但这一拍用不上的(比如给设计卡说"别裁")—— 回复里讲清楚 */
  problems: string[];
  /** 没认出的剩余文字 —— 回复里告诉她这部分没动 */
  leftover: string;
};

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? NaN;
  // 十一..十九 / 二十 / 二十三
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (!m) return NaN;
  return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
}
const pad = (n: number) => `c${String(n).padStart(2, "0")}`;

// 说"慢一点"时提到了念/语速 = 说的是配音,不是画面 —— 交给原来的改稿通道
const VOICE_WORDS = /念|读|语速|配音|声音|说话|嗓|语气|音调|口播/;
// 在改台词(「第3句改成……别裁掉任何人」)—— 引号或"改成"后面的字是台词内容,不是指令
const TEXT_EDIT = /改成|改为|换成|写成|加一句|插一句|删掉第|删了第|[“”「」"]/;
// 动画卡/录屏只支持很轻的推拉(满幅设计的卡推多了会啃到四边文字)
const CAMERA_FALLBACK: Record<string, string> = { pushIn: "pushSoft", pullOut: "pullSoft" };

type Rule = { re: RegExp; apply: (m: RegExpMatchArray, cur: (k: keyof Overrides) => number | string | undefined) => Overrides | "reset" };
const RULES: Rule[] = [
  { re: /(恢复|改回|还原)(成)?(默认|自动|原样|原来的?)|撤销(参数|覆盖|设置)?|按(系统|默认)的?来/, apply: () => "reset" },
  { re: /(别|不要|不用|不)(再)?(裁|切)(掉|了|边)?|整幅|完整(地)?(放|显示|露出)|放全|全部?放进/, apply: () => ({ fit: "contain" }) },
  { re: /铺满|裁满|填满|(可以|就)裁/, apply: () => ({ fit: "cover" }) },
  { re: /(放慢|慢放?)\s*(到)?\s*(\d+(?:\.\d+)?)\s*倍/, apply: (m) => ({ slow: Number(m[3]) }) },
  { re: /原速|正常速度|(别|不要|不用)(再)?(放慢|慢)/, apply: () => ({ slow: 1 }) },
  { re: /(再)?慢(一)?(点|些)|放慢/, apply: (_m, cur) => ({ slow: Math.min(3, round2(Number(cur("slow") ?? 1) + 0.25)) }) },
  { re: /(再)?快(一)?(点|些)|加速/, apply: (_m, cur) => ({ slow: Math.max(0.5, round2(Number(cur("slow") ?? 1) - 0.25)) }) },
  { re: /冻住|定格|冻帧|停在最后(一帧)?|(别|不要|不用)(硬)?循环|(别|不要|不用)(来回|正倒|倒)放/, apply: () => ({ fill: "freeze" }) },
  { re: /(?<!别|不要|不用|不)(正倒放|来回放|倒放)/, apply: () => ({ fill: "pingpong" }) },
  { re: /(硬)?循环(播放?)?/, apply: () => ({ fill: "loop" }) },
  { re: /从(第)?\s*(\d+(?:\.\d+)?)\s*秒(开始|起|处)?|跳过前\s*(\d+(?:\.\d+)?)\s*秒/, apply: (m) => ({ from: Number(m[2] ?? m[4]) }) },
  { re: /(别|不要|不用)(加)?(运镜|推拉|推镜|晃)|镜头(别|不要)动|固定镜头/, apply: () => ({ camera: "none" }) },
  { re: /推近|往前推/, apply: () => ({ camera: "pushIn" }) },
  { re: /拉远|往后拉/, apply: () => ({ camera: "pullOut" }) },
  { re: /左摇|往左(摇|移)/, apply: () => ({ camera: "panLeft" }) },
  { re: /右摇|往右(摇|移)/, apply: () => ({ camera: "panRight" }) },
];
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// 这一拍能不能用这个参数:进画只对她的素材有意义(设计卡本来就是按画面尺寸做的),
// 速度/补足/起点只对录屏视频有意义
function applicable(key: keyof Overrides, kind: BeatKind | undefined, v: unknown): string | null {
  if (!kind) return null;
  if (key === "fit" && (kind === "card" || kind === "anim")) return "是设计卡,本来就按画面尺寸做的,没有裁不裁的问题";
  if ((key === "slow" || key === "fill" || key === "from") && kind !== "video") return "不是录屏视频,没有播放速度/时长可调";
  if (key === "camera" && !CAMERA_CHOICES[kind]?.includes(String(v))) return `这种画面不支持「${String(v)}」运镜`;
  return null;
}

export function parseDirect(
  text: string,
  clips: { name: string }[],
  info: {
    kindOf: (clip: string) => BeatKind | undefined;
    /** 这一拍当前实际用的值(上次剪辑的决定 / 已有覆盖)—— 算"再慢一点"要用 */
    current: (clip: string, key: keyof Overrides) => number | string | undefined;
  },
): DirectParse | null {
  const t = text.trim();
  if (!t || TEXT_EDIT.test(t)) return null;

  // ── 指到哪几拍 ──
  const names = new Set(clips.map((c) => c.name));
  const beats: string[] = [];
  let rest = t;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => number[]) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      for (const n of fn(m)) if (n >= 1 && names.has(pad(n)) && !beats.includes(pad(n))) beats.push(pad(n));
      return " ";
    });
  };
  const range = (a: number, b: number) => (a <= b && b - a < 40 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]);
  take(/\bc(\d{1,2})\s*[-~到至]\s*c?(\d{1,2})\b/gi, (m) => range(Number(m[1]), Number(m[2])));
  take(/\bc(\d{1,2})\b/gi, (m) => [Number(m[1])]);
  take(/第\s*([0-9一二两三四五六七八九十]+)\s*[-~到至]\s*第?\s*([0-9一二两三四五六七八九十]+)\s*[拍句段个镜]/g, (m) => range(cnToInt(m[1]), cnToInt(m[2])));
  take(/第\s*([0-9一二两三四五六七八九十]+)\s*[拍句段个镜]/g, (m) => [cnToInt(m[1])]);
  let all = false;
  rest = rest.replace(/所有(的)?(拍|素材|录屏)?|全部(的)?(拍|素材|录屏)?|每一?拍|全片/g, () => { all = true; return " "; });
  if (all) for (const c of clips) if (!beats.includes(c.name)) beats.push(c.name);
  if (!beats.length) return null;

  // ── 说了哪些参数 ──
  const found: (Overrides | "reset")[] = [];
  const beat0 = beats[0];
  for (const rule of RULES) {
    const m = rest.match(rule.re);
    if (!m) continue;
    found.push(rule.apply(m, (k) => info.current(beat0, k)));
    rest = rest.replace(new RegExp(rule.re.source, "g"), " "); // 同一类说法出现两次(冻住……别来回放)一起吃掉
  }
  if (!found.length) return null;
  if (VOICE_WORDS.test(t) && found.some((f) => f !== "reset" && f.slow != null)) return null;

  const changes: OverrideChange[] = [];
  const problems: string[] = [];
  for (const b of beats) {
    const kind = info.kindOf(b);
    if (found.includes("reset")) {
      changes.push({ clip: b, unset: "all" });
      continue;
    }
    const set: Overrides = {};
    for (const f of found) {
      if (f === "reset") continue;
      for (const [k, v] of Object.entries(f) as [keyof Overrides, never][]) {
        // "再慢一点"对每一拍按它自己的当前值算
        let val: unknown = v;
        if (k === "slow" && beats.length > 1 && /慢|快|加速/.test(t) && !/倍|原速|正常/.test(t)) {
          const cur = Number(info.current(b, "slow") ?? 1);
          val = /快|加速/.test(t) ? Math.max(0.5, round2(cur - 0.25)) : Math.min(3, round2(cur + 0.25));
        }
        if (k === "camera" && kind && !CAMERA_CHOICES[kind]?.includes(String(val)) && CAMERA_FALLBACK[String(val)]) {
          val = CAMERA_FALLBACK[String(val)];
        }
        const bad = applicable(k, kind, val);
        if (bad) {
          // 说"所有拍别裁"时,设计卡不适用是预期内的,不用逐拍报
          if (!all) problems.push(`${b} ${bad}`);
          continue;
        }
        (set as Record<string, unknown>)[k] = val;
      }
    }
    if (Object.keys(set).length) changes.push({ clip: b, set });
  }

  const leftover = rest
    .replace(/[，。,.!！?？、;；:：\s~～…]+/g, " ")
    .replace(/(把|给|将|让|这一?拍|那一?拍|一下|吧|呢|啊|呀|了|的|也|和|跟|还有|然后|都|请|帮我|麻烦|画面|素材|录屏|视频)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { changes, problems, leftover: leftover.length > 1 ? leftover : "" };
}
