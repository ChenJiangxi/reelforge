// 时间轴的共用算法(网页和服务端接口用;worker 那边有同样逻辑的 JS 版)。
import type { Artifacts, Insert } from "@/lib/stages";

type VoiceClip = { name: string; dur: number; gap?: number; words?: [string, number, number][] };
type EditTl = { name: string; start: number; dur: number; gap: number };

const PUNCT = /[\p{P}\p{S}\s]/u;

/** 一拍的逐字时间 → 去掉标点的字串 + 每个字的开始时间(秒,相对这拍开头) */
export function spokenIndex(words: [string, number, number][] = []) {
  let text = "";
  const times: number[] = [];
  for (const [w, b] of words) {
    for (const ch of [...String(w)]) {
      if (PUNCT.test(ch)) continue;
      text += ch;
      times.push(b / 1000);
    }
  }
  return { text, times };
}

/**
 * 每拍在成片里的位置。剪辑跑过就用它的时间轴(含你拖过的停顿、插进来的纯画面);
 * 还没跑过就按配音算,再把还没渲的停顿覆盖/纯画面插入也算进去(网页上立刻看得到变化)。
 */
export function beatTimeline(voiceClips: VoiceClip[], edit: Artifacts | undefined, clips: { name: string; overrides?: { gap?: number }; inserts?: Insert[] }[]): EditTl[] {
  const byName = new Map(clips.map((c) => [c.name, c]));
  let t = 0;
  return voiceClips.map((v) => {
    const c = byName.get(v.name);
    const base = c?.overrides?.gap ?? v.gap ?? 0.18;
    const extra = (c?.inserts || []).filter((x) => x.kind === "gap").reduce((n, x) => n + Number(x.dur || 0), 0);
    const row = { name: v.name, start: Number(t.toFixed(3)), dur: v.dur, gap: base + extra };
    t += v.dur + row.gap;
    return row;
  }).map((row, i, all) => {
    // 剪辑的时间轴只在"它就是按现在这些设置渲的"时才可信 —— 否则用上面按当前设置算的
    const e = edit?.timeline?.[i];
    return e && e.name === row.name && Math.abs(e.gap - row.gap) < 0.01 && Math.abs(e.dur - row.dur) < 0.01 ? e : { ...row, start: i ? all[i - 1].start + all[i - 1].dur + all[i - 1].gap : 0 };
  });
}

/** 成片里的一个时间点 → 第几拍、这拍第几秒、念到哪个字 */
export function locate(t: number, tl: EditTl[], voiceClips: VoiceClip[]) {
  let i = tl.findIndex((b) => t >= b.start && t < b.start + b.dur + b.gap);
  if (i < 0) i = t < 0 ? 0 : tl.length - 1;
  const b = tl[i];
  const local = Math.max(0, t - b.start);
  const idx = spokenIndex(voiceClips[i]?.words || []);
  // 找这个时刻正在念(或刚念到)的字
  let ci = -1;
  for (let k = 0; k < idx.times.length; k++) {
    if (idx.times[k] <= local + 0.05) ci = k;
    else break;
  }
  if (ci < 0 && idx.times.length) ci = 0;
  const anchor = ci >= 0 ? { charIdx: ci, text: [...idx.text].slice(ci, ci + 4).join("") } : undefined;
  return { index: i, name: b.name, local, anchor, inSpeech: local <= b.dur };
}

/** 插入在成片里的位置(网页时间轴显示用,和 worker 的 anchorTime 同一套规则) */
export function insertSpans(tl: EditTl[], voiceClips: VoiceClip[], clips: { name: string; overrides?: { gap?: number }; inserts?: Insert[] }[]) {
  const out: (Insert & { clip: string; start: number; end: number })[] = [];
  tl.forEach((b, i) => {
    const c = clips.find((x) => x.name === b.name);
    const v = voiceClips[i];
    let gapCursor = b.start + b.dur + (c?.overrides?.gap ?? v?.gap ?? 0.18);
    for (const ins of c?.inserts || []) {
      let start: number;
      if (ins.kind === "gap") {
        start = gapCursor;
        gapCursor += ins.dur;
      } else {
        const idx = spokenIndex(v?.words || []);
        let local = ins.offset ?? 0;
        if (ins.anchor?.text) {
          const exact = [...idx.text].slice(ins.anchor.charIdx, ins.anchor.charIdx + [...ins.anchor.text].length).join("") === ins.anchor.text;
          const at = exact ? ins.anchor.charIdx : [...idx.text.slice(0, Math.max(0, idx.text.indexOf(ins.anchor.text)))].length;
          if (idx.text.includes(ins.anchor.text) && idx.times[at] != null) local = idx.times[at];
        }
        start = b.start + local;
      }
      out.push({ ...ins, clip: b.name, start, end: start + ins.dur });
    }
  });
  return out;
}
