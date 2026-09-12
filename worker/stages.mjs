// The eight stage executors. Each takes the poll item (project + upstream
// artifacts) and returns the artifacts patch to submit for review.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chatJSON } from "./llm.mjs";
import { PROMPTS } from "./prompts.mjs";
import { renderCard, renderSubLine, sizeFor, closeBrowser } from "./cards.mjs";
import { ffmpeg, ffprobeDur } from "./ffmpeg.mjs";
import { upload, download } from "./board.mjs";

const WORK_ROOT = process.env.WORK_DIR || join(process.cwd(), "data", "work");
const GAP = 0.25; // silence between clips (seconds), matches ops-bilibili builds

// When she rejects a stage with a note, the note must steer the redo —
// append it to whatever prompt the stage was going to send.
function guided(item, messages) {
  if (!item.reviewNote) return messages;
  const out = messages.map((m) => ({ ...m }));
  out[out.length - 1].content += `\n\n【打回批注——必须针对这条改,不是重做】${item.reviewNote}`;
  return out;
}

function workDir(item, sub = "") {
  const d = join(WORK_ROOT, item.projectId, sub);
  mkdirSync(d, { recursive: true });
  return d;
}

// ── MiniMax TTS (international region — domestic endpoint rejects this key) ──
const VOICES = {
  "clone-zh": { voice_id: "jessy1777965074473", speed: 1.26, boost: "Chinese" },
  "minimax-en": { voice_id: "English_expressive_narrator", speed: 1.0, boost: "English" },
};

async function tts(text, profile) {
  const base = (process.env.MINIMAX_API_BASE || "https://api.minimax.io/v1") + "/t2a_v2";
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not in env");
  const r = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "speech-2.5-hd-preview",
      text,
      voice_setting: { voice_id: profile.voice_id, speed: profile.speed, vol: 1.0, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      language_boost: profile.boost,
      subtitle_enable: false,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.base_resp?.status_code !== 0) {
    throw new Error(`minimax: ${JSON.stringify(j?.base_resp || j).slice(0, 200)}`);
  }
  return Buffer.from(j.data.audio, "hex");
}

async function voiceClip(item, clip, dir) {
  const p = join(dir, `${clip.name}.mp3`);
  const marker = join(dir, `${clip.name}.txt`);
  // Re-generate when the line changed, even if an old mp3 with this name exists
  // (chat edits reuse clip names; TTS is cheap, stale audio is confusing).
  const stale = !existsSync(p) || !existsSync(marker) || readFileSync(marker, "utf8") !== clip.text;
  if (stale) {
    writeFileSync(p, await tts(clip.text, VOICES[item.voice] || VOICES["clone-zh"]));
    writeFileSync(marker, clip.text);
  }
  return { path: p, dur: await ffprobeDur(p) };
}

// ── stages ────────────────────────────────────────────────────────────────

async function topic(item) {
  const out = await chatJSON(guided(item, PROMPTS.topic(item)), { temperature: 0.8 });
  const note = [
    `角度:${out.angle}`,
    `钩子:${out.hook}`,
    "",
    "要讲的:",
    ...(out.claims || []).map((c) => `· ${c}`),
    "",
    "不吹:",
    ...(out.avoid || []).map((c) => `· ${c}`),
  ].join("\n");
  return { note, topic: out };
}

async function script(item) {
  const t = item.upstream?.topic?.topic;
  if (!t) throw new Error("上游选题没有结构化数据(topic.topic 缺失)");
  // Two passes: draft the coherent narration, then a chief-editor critique.
  // Learned from MuseDock: narration is one flowing piece (hook→landing),
  // segmented into beats of 1-3 sentences — never a list of one-liners.
  const draft = await chatJSON(guided(item, PROMPTS.script(item, t)), { temperature: 0.75, maxTokens: 6000 });
  const out = await chatJSON(PROMPTS.scriptCritique(item, draft), { temperature: 0.5, maxTokens: 6000 });
  if (!Array.isArray(out.clips) || out.clips.length < 3) throw new Error("脚本 clips 太少或格式错误");
  out.clips.forEach((c, i) => { c.name = `c${String(i + 1).padStart(2, "0")}`; });
  const narration = out.narration || out.clips.map((c) => c.text).join("\n");
  const chars = out.clips.reduce((n, c) => n + c.text.length, 0);
  const arc = out.clips.map((c) => c.beat).filter(Boolean).join("→");
  return {
    script: narration,
    clips: out.clips,
    note: `${out.clips.length} 拍(${arc || "无节拍标注"}),约 ${chars} 字(目标 ~${item.duration}s)。连贯性/人味已经过一遍主编审稿。`,
  };
}

async function footage(item) {
  const clips = item.upstream?.script?.clips;
  if (!clips?.length) throw new Error("上游脚本没有 clips");
  const dir = workDir(item, "cards");
  const size = sizeFor(item.aspect);
  // Reuse card designs from a previous pass for clips whose text is unchanged —
  // chat edits usually touch one line; regenerating all designs is waste.
  const prevByName = new Map(
    (item.artifacts?.cards || []).map((c) => [c.name, c]),
  );
  const images = [];
  const cards = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const prev = prevByName.get(clip.name);
    let content;
    if (prev && !item.reviewNote && prev.text === clip.text && prev.big) {
      content = { type: prev.type, kicker: prev.kicker, big: prev.big, sub: prev.sub, foot: prev.foot };
      console.log(`  [footage] ${clip.name} reuse design`);
    } else {
      console.log(`  [footage] ${clip.name} designing…`);
      content = await chatJSON(guided(item, PROMPTS.card(item, clip, i, clips.length)), { temperature: 0.6 });
    }
    const png = join(dir, `${clip.name}.png`);
    await renderCard(content, size, png);
    console.log(`  [footage] ${clip.name} rendered, uploading`);
    const { url } = await upload(item.projectId, png, `card-${clip.name}.png`);
    images.push(url);
    cards.push({ name: clip.name, text: clip.text, ...content });
  }
  await closeBrowser();
  return { images, cards, note: `${images.length} 张大字卡(${item.aspect})。画面和台词是否对得上,请审。` };
}

async function voice(item) {
  const clips = item.upstream?.script?.clips;
  if (!clips?.length) throw new Error("上游脚本没有 clips");
  const dir = workDir(item, "voice");
  const profile = VOICES[item.voice] || VOICES["clone-zh"];
  const meta = [];
  for (const c of clips) {
    console.log(`  [voice] ${c.name} tts…`);
    const { path: p, dur } = await voiceClip(item, c, dir);
    meta.push({ name: c.name, text: c.text, dur, file: p });
  }
  // preview: one mp3 she can listen to straight through
  const preview = join(dir, "preview.mp3");
  const inputs = meta.flatMap((m) => ["-i", m.file]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,apad,atrim=0:${(m.dur + 0.35).toFixed(3)}[a${i}]`).join(";");
  const concat = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[a]`;
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concat, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "4", preview]);
  const { url } = await upload(item.projectId, preview, "voice-preview.mp3");
  // waveform image for the editor's audio track (like an NLE timeline)
  const wave = join(dir, "voice-wave.png");
  await ffmpeg(["-i", preview, "-filter_complex", "showwavespic=s=1800x140:colors=#e8622c", "-frames:v", "1", wave]);
  const { url: waveUrl } = await upload(item.projectId, wave, "voice-wave.png");
  const total = meta.reduce((n, m) => n + m.dur, 0);
  return {
    audio: url,
    wave: waveUrl,
    voiceMeta: { clips: meta.map(({ name, text, dur }) => ({ name, text, dur })), gap: GAP },
    note: `音色 ${profile.voice_id} @${profile.speed}x,共 ${total.toFixed(1)}s(${meta.length} 句)。配音够不够激情、地不地道,请审听。`,
  };
}

// fetch footage cards / regenerate voice locally if a previous run's files are gone
async function ensureInputs(item) {
  const up = item.upstream || {};
  const cardsDir = workDir(item, "cards");
  const voiceDir = workDir(item, "voice");
  const meta = up.voice?.voiceMeta?.clips;
  const images = up.footage?.images || [];
  const cards = [];
  for (let i = 0; i < images.length; i++) {
    const name = up.script.clips[i].name;
    const p = join(cardsDir, `${name}.png`);
    if (!existsSync(p)) await download(images[i], p);
    cards.push(p);
  }
  const voices = [];
  for (const m of meta || []) {
    const p = join(voiceDir, `${m.name}.mp3`);
    if (!existsSync(p)) await voiceClip(item, m, voiceDir);
    voices.push(p);
  }
  return { cards, voices, meta };
}

async function edit(item) {
  const { cards, voices, meta } = await ensureInputs(item);
  if (!cards.length || cards.length !== voices.length) throw new Error("卡片和配音数量对不上");
  const { width: W, height: H } = sizeFor(item.aspect);
  const dir = workDir(item, "edit");
  const fps = 30;

  // 1) per-clip video segments: subtle zoom into the card, length = voice + GAP
  const segs = [];
  for (let i = 0; i < cards.length; i++) {
    const segDur = meta[i].dur + GAP;
    const frames = Math.ceil(segDur * fps);
    const seg = join(dir, `seg-${meta[i].name}.mp4`);
    const zoom = `scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='1+0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},format=yuv420p`;
    await ffmpeg(["-loop", "1", "-framerate", String(fps), "-t", segDur.toFixed(3), "-i", cards[i], "-vf", zoom, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", seg]);
    console.log(`  [edit] seg ${meta[i].name} ${segDur.toFixed(1)}s done`);
    segs.push(seg);
  }

  // 2) concat video
  const listFile = join(dir, "concat.txt");
  writeFileSync(listFile, segs.map((s) => `file '${s}'`).join("\n"));
  const videoOnly = join(dir, "video-only.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoOnly]);

  // 3) voice track: each clip padded to its segment length, then concat
  const inputs = voices.flatMap((v) => ["-i", v]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,volume=5dB,apad,atrim=0:${(m.dur + GAP).toFixed(3)}[a${i}]`).join(";");
  const concatF = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[av]`;
  const voiceM4a = join(dir, "voice.m4a");
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concatF, "-map", "[av]", voiceM4a]);

  // 4) mux (+ optional BGM bed)
  const out = join(dir, "edit.mp4");
  const bgmFile = item.bgm === "yes" ? readdirSafe(join(process.cwd(), "worker", "bgm")).find((f) => f.endsWith(".mp3")) : null;
  if (bgmFile) {
    const total = meta.reduce((n, m) => n + m.dur + GAP, 0);
    await ffmpeg([
      "-i", videoOnly, "-i", voiceM4a, "-stream_loop", "-1", "-i", join(process.cwd(), "worker", "bgm", bgmFile),
      "-filter_complex", `[2:a]aresample=44100,volume=-18dB,atrim=0:${total.toFixed(3)}[bg];[1:a][bg]amix=inputs=2:duration=first:normalize=0[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", out,
    ]);
  } else {
    await ffmpeg(["-i", videoOnly, "-i", voiceM4a, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", out]);
  }

  console.log("  [edit] uploading edit.mp4…");
  const { url } = await upload(item.projectId, out, "edit.mp4");
  const total = await ffprobeDur(out);
  return {
    video: url,
    note: `粗剪 ${total.toFixed(1)}s,${cards.length} 拍${bgmFile ? "(带 BGM 垫底)" : "(无 BGM)"}。节奏/画面对位请审。`,
  };
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

// ── subtitles ──────────────────────────────────────────────────────────────

function splitLines(text) {
  const parts = text.replace(/——|—/g, ",").split(/[，。！？、；：,.!?;:]/).map((s) => s.trim()).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length <= 14) cur += p;
    else { if (cur) lines.push(cur); cur = p; }
    if (cur.length >= 12) { lines.push(cur); cur = ""; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

async function subtitles(item) {
  const meta = item.upstream?.voice?.voiceMeta?.clips;
  const editVideo = item.upstream?.edit?.video;
  if (!meta?.length || !editVideo) throw new Error("缺上游配音时间轴或粗剪视频");
  const size = sizeFor(item.aspect);
  const dir = workDir(item, "subs");

  const local = join(dir, "edit.mp4");
  if (!existsSync(local)) await download(editVideo, local);

  // One transparent PNG per ≤14-char line; time allocated by char share of the
  // clip. Burned via overlay+enable (this ffmpeg build has no libass/drawtext).
  const gap = item.upstream.voice.voiceMeta.gap ?? GAP;
  let offset = 0;
  const overlays = []; // { png, start, end }
  for (const m of meta) {
    const lines = splitLines(m.text);
    const tot = lines.reduce((n, l) => n + l.length, 0) || 1;
    let t = offset;
    for (const l of lines) {
      const seg = (m.dur * l.length) / tot;
      const png = join(dir, `line-${String(overlays.length).padStart(3, "0")}.png`);
      await renderSubLine(l, size, png);
      overlays.push({ png, start: t, end: t + seg });
      t += seg;
    }
    offset += m.dur + gap;
  }
  await closeBrowser();

  const inputs = overlays.flatMap((o) => ["-i", o.png]);
  const chain = overlays
    .map((o, i) => {
      const src = i === 0 ? "0:v" : `v${i}`;
      const dst = i === overlays.length - 1 ? "vout" : `v${i + 1}`;
      return `[${src}][${i + 1}:v]overlay=0:0:enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[${dst}]`;
    })
    .join(";");
  const out = join(dir, "subs.mp4");
  await ffmpeg(["-i", local, ...inputs, "-filter_complex", chain, "-map", "[vout]", "-map", "0:a", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "copy", out]);
  console.log("  [subtitles] uploading subs.mp4…");
  const { url } = await upload(item.projectId, out, "subs.mp4");
  return { video: url, note: `字幕已烧录(${overlays.length} 行)。错字/断句/位置请审。` };
}

async function polish(item) {
  const video = item.upstream?.subtitles?.video || item.upstream?.edit?.video;
  if (!video) throw new Error("上游没有成片视频");
  return {
    video,
    note: "成片完成。要微调(节奏/某句/某画面)就打回写批注;满意就通过,进入交付打包。",
  };
}

async function deliver(item) {
  const up = item.upstream || {};
  const t = up.topic?.topic || { angle: item.topic, hook: "" };
  const scriptText = up.script?.script || "";
  const size = sizeFor(item.aspect);

  const cov = await chatJSON(guided(item, PROMPTS.cover(item, t, scriptText)), { temperature: 0.8 });
  const dir = workDir(item, "deliver");
  const png = join(dir, "cover.png");
  await renderCard({ kicker: "", big: cov.main, sub: cov.sub, type: "text" }, size, png);
  await closeBrowser();
  const { url: coverUrl } = await upload(item.projectId, png, "cover.png");

  const caption = await chatJSON(guided(item, PROMPTS.caption(item, t, scriptText)), { temperature: 0.7 });
  return {
    cover: coverUrl,
    caption,
    note: "封面 + 抖音文案。通过后自动打包(视频+封面+文案 zip)可下载。",
  };
}

export const STAGES = { topic, script, footage, voice, edit, subtitles, polish, deliver };
