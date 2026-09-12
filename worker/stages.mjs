// The eight stage executors. Each takes the poll item (project + upstream
// artifacts) and returns the artifacts patch to submit for review.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chatJSON, reviewImage } from "./llm.mjs";
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
// 音色表(全部在 ops-bilibili 实测过):克隆音绑定主账号,系统音任意 key 可用。
const VOICES = {
  "clone-zh": { voice_id: "jessy1777965074473", speed: 1.26, boost: "Chinese" },
  "presenter-male": { voice_id: "presenter_male", speed: 1.3, boost: "Chinese" },
  "female-tianmei": { voice_id: "female-tianmei", speed: 1.15, boost: "Chinese" },
  "female-shaonv": { voice_id: "female-shaonv", speed: 1.15, boost: "Chinese" },
  "audiobook-male": { voice_id: "audiobook_male_1", speed: 1.4, boost: "Chinese" },
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
  const assets = item.assets || [];
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
    // 素材优先:聊天指定的(clip.asset)> LLM 挑的 > 字卡
    let assetName = clip.asset || null;
    let content = null;
    let freshDesign = false;
    if (!assetName) {
      if (prev && !item.reviewNote && prev.text === clip.text && (prev.big || prev.asset)) {
        if (prev.asset) assetName = prev.asset;
        else content = { type: prev.type, kicker: prev.kicker, big: prev.big, sub: prev.sub, foot: prev.foot, big2: prev.big2, step_no: prev.step_no };
        console.log(`  [footage] ${clip.name} reuse ${assetName ? "asset " + assetName : "design"}`);
      } else {
        console.log(`  [footage] ${clip.name} designing…`);
        content = await chatJSON(guided(item, PROMPTS.card(item, clip, i, clips.length)), { temperature: 0.6 });
        freshDesign = true;
        if (content.asset && assets.some((a) => a.name === content.asset)) {
          assetName = content.asset;
          content = null;
          freshDesign = false;
        }
      }
    }

    if (assetName) {
      const asset = assets.find((a) => a.name === assetName);
      if (!asset) throw new Error(`素材 ${assetName} 不在项目素材库`);
      let posterUrl = asset.url;
      if (asset.kind === "video") {
        // poster frame so the cards grid / timeline has something to show
        const local = join(workDir(item, "assets"), asset.name);
        if (!existsSync(local)) await download(asset.url, local);
        const poster = join(dir, `${clip.name}-poster.png`);
        await ffmpeg(["-ss", "0.5", "-i", local, "-frames:v", "1", "-vf", `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`, poster]);
        const up = await upload(item.projectId, poster, `asset-${clip.name}-poster.png`);
        posterUrl = up.url;
      }
      console.log(`  [footage] ${clip.name} uses asset ${assetName}`);
      images.push(posterUrl);
      cards.push({ name: clip.name, text: clip.text, asset: assetName });
      continue;
    }

    const png = join(dir, `${clip.name}.png`);
    // 视觉审稿循环(只对新设计):渲出来 → 视觉模型按教案挑毛病 → 有问题改内容重渲一次
    let passes = freshDesign ? 2 : 1;
    for (let pass = 1; pass <= passes; pass++) {
      await renderCard(content, size, png);
      if (!freshDesign) break;
      const qa = await reviewImage(
        png,
        `审这张短视频画面卡(口播:"${clip.text}")。清单:1)第一眼是否落在主信息上 2)文字有没有溢出/被裁切/挤出画面 3)底部 17% 字幕安全区有没有被占用 4)有没有错别字/多字漏字 5)卡内容和口播是否相关 6)信息量:如果这卡只有一句短话的大字、而这拍讲的是知识/关系/对比内容,就是不达标(该用关系图/对照表/步骤链)`,
      );
      if (qa.ok || pass === passes) {
        if (!qa.ok) console.log(`  [footage] ${clip.name} QA 仍有 issue(放行):${qa.issues?.join(";")}`);
        break;
      }
      console.log(`  [footage] ${clip.name} QA 打回:${qa.issues?.join(";")} → 重设计`);
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `上一版被视觉审稿打回:${qa.issues?.join(";")}。针对问题改,返回同样结构的 JSON。` }],
        { temperature: 0.4 },
      );
    }
    console.log(`  [footage] ${clip.name} rendered, uploading`);
    const { url } = await upload(item.projectId, png, `card-${clip.name}.png`);
    images.push(url);
    cards.push({ name: clip.name, text: clip.text, ...content });
  }
  await closeBrowser();
  const assetCount = cards.filter((c) => c.asset).length;
  return {
    images,
    cards,
    note: `${images.length} 拍画面(${item.aspect})${assetCount ? `,其中 ${assetCount} 拍用了你的真素材` : ""}。画面和台词是否对得上,请审。`,
  };
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

// fetch footage sources / regenerate voice locally if a previous run's files are gone
async function ensureInputs(item) {
  const up = item.upstream || {};
  const cardsDir = workDir(item, "cards");
  const assetsDir = workDir(item, "assets");
  const voiceDir = workDir(item, "voice");
  const meta = up.voice?.voiceMeta?.clips;
  const cardsMeta = up.footage?.cards || [];
  const images = up.footage?.images || [];
  const assets = item.assets || [];

  // per-clip visual source: 真素材(录屏/图片) > 字卡
  const visuals = [];
  for (let i = 0; i < cardsMeta.length; i++) {
    const cm = cardsMeta[i];
    if (cm.asset) {
      const asset = assets.find((a) => a.name === cm.asset);
      if (!asset) throw new Error(`素材 ${cm.asset} 不在项目素材库`);
      const p = join(assetsDir, cm.asset);
      if (!existsSync(p)) await download(asset.url, p);
      visuals.push({ kind: asset.kind, path: p });
    } else {
      const p = join(cardsDir, `${cm.name}.png`);
      if (!existsSync(p) && images[i]) await download(images[i], p);
      visuals.push({ kind: "image", path: p });
    }
  }
  const voices = [];
  for (const m of meta || []) {
    const p = join(voiceDir, `${m.name}.mp3`);
    if (!existsSync(p)) await voiceClip(item, m, voiceDir);
    voices.push(p);
  }
  return { visuals, voices, meta };
}

async function edit(item) {
  const { visuals, voices, meta } = await ensureInputs(item);
  if (!visuals.length || visuals.length !== voices.length) throw new Error("画面和配音数量对不上");
  const { width: W, height: H } = sizeFor(item.aspect);
  const dir = workDir(item, "edit");
  const fps = 30;

  // 1) per-clip video segments: card/image gets a subtle zoom; 录屏裁切铺满
  const segs = [];
  for (let i = 0; i < visuals.length; i++) {
    const segDur = meta[i].dur + GAP;
    const frames = Math.ceil(segDur * fps);
    const seg = join(dir, `seg-${meta[i].name}.mp4`);
    if (visuals[i].kind === "video") {
      await ffmpeg(["-stream_loop", "-1", "-i", visuals[i].path, "-t", segDur.toFixed(3), "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p`, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", seg]);
    } else {
      const zoom = `scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='1+0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps},format=yuv420p`;
      await ffmpeg(["-loop", "1", "-framerate", String(fps), "-t", segDur.toFixed(3), "-i", visuals[i].path, "-vf", zoom, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", seg]);
    }
    console.log(`  [edit] seg ${meta[i].name} ${segDur.toFixed(1)}s done (${visuals[i].kind})`);
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
    note: `粗剪 ${total.toFixed(1)}s,${visuals.length} 拍${bgmFile ? "(带 BGM 垫底)" : "(无 BGM)"}。节奏/画面对位请审。`,
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
