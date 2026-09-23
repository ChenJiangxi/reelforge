// 音效层(素材是 Mixkit 免费音效)。2026-09-24 起照 ops-bilibili 她认可的做法收紧:
//   只在章节入口放(节拍从铺垫转到论据、转折、落点的那一刀),全片最多 min(8, 1+时长/15) 个,
//   不给每次换拍、每个元素出现配「嗖」「啵」—— 景甜基准片也只在章节入口有克制的电影感音效。
//   重音效之间 ≥3s、不压在一句话的开头 ±0.35s 里、人声期间再压低 8dB、音量夹在 -28…-14dB(约 0.10–0.20)。
// 这一层会改变片子的听感 —— 项目级开关在决定清单里(剪辑 → 音效 开/关)。
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "./ffmpeg.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "sfx");
const LIB = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "library.json"), "utf8")).items;
  } catch {
    return [];
  }
})();
const file = (id) => {
  const it = LIB.find((x) => x.id === id);
  return it && existsSync(join(HERE, it.file)) ? { path: join(HERE, it.file), dur: it.duration_sec } : null;
};

export function sfxReady() {
  return !!(file("mixkit-whoosh-cinematic-fast") && file("mixkit-pop-explainer-light"));
}

const SOUNDS = {
  cutStrong: { id: "mixkit-whoosh-cinematic-fast", db: -16, high: true, label: "转折/落点「嗖」" },
  cut: { id: "mixkit-swoosh-fast-transition", db: -20, label: "章节入口轻「嗖」" },
  reveal: { id: "mixkit-pop-explainer-light", db: -22, label: "分步出现「啵」" },
  draw: { id: "mixkit-paper-pencil-write", db: -24, label: "手绘开笔「沙沙」" },
};

const MIN_GAP = 0.6;
const MAX_PER_BEAT = 2;
const MIN_HIGH_GAP = 3;
const AVOID_START = 0.35;
const VOICE_DUCK = 8;
const clampDb = (v) => Math.max(-28, Math.min(-14, v));

/**
 * beats: [{ name, start (全片秒), dur, words, transitionIn?: {type,dur}, reveals?: [秒,相对这拍], drawn?: bool }]
 * 返回 { events: [{t, kind, db, beat, label}], dropped: [{beat, label, why}] }
 */
export function planSfx(beats) {
  // 每句话的开头(全片秒):一拍的第一个字 + 标点后的第一个字
  const phraseStarts = [];
  const voiced = []; // [开始, 结束] 有人声的区间
  for (const b of beats) {
    let fresh = true;
    for (const [w, s, e] of b.words || []) {
      if (/[\p{P}\s]/u.test(w)) {
        fresh = true;
        continue;
      }
      if (fresh) phraseStarts.push(b.start + s / 1000);
      fresh = false;
      voiced.push([b.start + s / 1000, b.start + e / 1000]);
    }
  }
  const nearStart = (t) => phraseStarts.some((p) => Math.abs(p - t) < AVOID_START);
  const inVoice = (t) => voiced.some(([a, e]) => t >= a - 0.05 && t <= e + 0.05);

  const want = [];
  for (let i = 1; i < beats.length; i++) {
    const b = beats[i];
    const prev = beats[i - 1];
    // 章节入口:这拍的节拍类型和上一拍不同(铺垫 → 论据 → 转折 → 落点)。放在上一拍句尾的空隙里(切点前 0.25s)
    if (b.kind && prev.kind && b.kind !== prev.kind) {
      const strong = b.kind === "turn" || b.kind === "landing";
      want.push({ t: Math.max(0, b.start - 0.25), kind: strong ? "cutStrong" : "cut", beat: b.name, atCut: true });
    }
  }
  want.sort((a, b) => a.t - b.t);

  const events = [];
  const dropped = [];
  const total = beats.length ? beats[beats.length - 1].start + beats[beats.length - 1].dur : 0;
  const cap = Math.min(8, 1 + Math.floor(total / 15));
  for (const w of want) {
    const s = SOUNDS[w.kind];
    const drop = (why) => dropped.push({ beat: w.beat, label: s.label, why });
    if (!file(s.id)) {
      drop("音效文件不在本机");
      continue;
    }
    const sameBeat = events.filter((e) => e.beat === w.beat);
    if (sameBeat.length >= MAX_PER_BEAT) { drop(`这拍已经有 ${MAX_PER_BEAT} 个了`); continue; }
    if (sameBeat.some((e) => Math.abs(e.t - w.t) < MIN_GAP)) { drop(`离这拍上一个音效不到 ${MIN_GAP}s`); continue; }
    if (s.high && events.some((e) => SOUNDS[e.kind].high && Math.abs(e.t - w.t) < MIN_HIGH_GAP)) { drop(`离上一个重音效不到 ${MIN_HIGH_GAP}s`); continue; }
    // 换拍音效本来就在切点前的空隙里;其它音效压到句首就不放
    if (!w.atCut && nearStart(w.t)) { drop("正好压在一句话的开头"); continue; }
    if (events.length >= cap) { drop(`全片最多 ${cap} 个`); continue; }
    const db = clampDb(s.db - (inVoice(w.t) ? VOICE_DUCK : 0));
    events.push({ ...w, db, label: s.label, voiced: inVoice(w.t) });
  }
  return { events, dropped };
}

/** 把音效混成一条和成片一样长的音轨(m4a) */
export async function renderSfxTrack(events, totalSec, out) {
  if (!events.length) return null;
  const inputs = [];
  const filters = [];
  events.forEach((e, i) => {
    inputs.push("-i", file(SOUNDS[e.kind].id).path);
    const ms = Math.round(e.t * 1000);
    filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${e.db}dB,adelay=${ms}|${ms}[s${i}]`);
  });
  const mix = `${events.map((_, i) => `[s${i}]`).join("")}amix=inputs=${events.length}:normalize=0:duration=longest,apad,atrim=0:${totalSec.toFixed(3)}[sfx]`;
  await ffmpeg([...inputs, "-filter_complex", `${filters.join(";")};${mix}`, "-map", "[sfx]", "-c:a", "aac", "-b:a", "128k", out]);
  return out;
}
