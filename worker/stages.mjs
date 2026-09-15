// The eight stage executors. Each takes the poll item (project + upstream
// artifacts) and returns the artifacts patch to submit for review.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chatJSON, reviewImage, reviewFrames } from "./llm.mjs";
import { PROMPTS } from "./prompts.mjs";
import { renderCard, renderCardVideo, renderSubLine, sizeFor, closeBrowser } from "./cards.mjs";
import { ffmpeg, ffprobeDur, ffprobeInfo, ffmpegOut } from "./ffmpeg.mjs";
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
// speech-2.8-hd 实测支持克隆音 + emotion + <#x#> 停顿标记(2026-09-15 实测)。
const TTS_MODEL = process.env.MINIMAX_MODEL || "speech-2.8-hd";
const VOICES = {
  "clone-zh": { voice_id: "jessy1777965074473", speed: 1.26, boost: "Chinese" },
  "presenter-male": { voice_id: "presenter_male", speed: 1.3, boost: "Chinese" },
  "female-tianmei": { voice_id: "female-tianmei", speed: 1.15, boost: "Chinese" },
  "female-shaonv": { voice_id: "female-shaonv", speed: 1.15, boost: "Chinese" },
  "audiobook-male": { voice_id: "audiobook_male_1", speed: 1.4, boost: "Chinese" },
  "minimax-en": { voice_id: "English_expressive_narrator", speed: 1.0, boost: "English" },
};

// 每拍的念法:LLM 给的 say 是相对基准音色的倍率/偏移,这里夹到 API 合法范围。
const EMOTIONS = new Set(["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper"]);
const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

export function delivery(profile, say = {}) {
  return {
    // say.speed 是相对基准的倍率。基准音色本身已经偏快(克隆音 1.26x),
    // 所以倍率收在 0.8-1.15、绝对值再封在 1.6 —— 更快就开始吞字了。
    speed: Number(clamp(profile.speed * clamp(say.speed, 0.8, 1.15, 1), 0.7, 1.6, profile.speed).toFixed(2)),
    pitch: Math.round(clamp(say.pitch, -6, 6, 0)),
    emotion: EMOTIONS.has(say.emotion) ? say.emotion : undefined,
    gap: clamp(say.gap_after, 0.05, 1.0, GAP),
  };
}

async function tts(text, profile, say) {
  const base = (process.env.MINIMAX_API_BASE || "https://api.minimax.io/v1") + "/t2a_v2";
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY not in env");
  const d = delivery(profile, say);
  const r = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: TTS_MODEL,
      text,
      voice_setting: {
        voice_id: profile.voice_id,
        speed: d.speed,
        vol: 1.0,
        pitch: d.pitch,
        ...(d.emotion ? { emotion: d.emotion } : {}),
      },
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

// voiceMeta 里存的是算完的绝对值(speed 已经乘过基准);voiceClip 收的是相对倍率,
// 所以补生成时要把它换算回去,否则会再乘一次基准。
function sayToInput(say) {
  if (!say) return undefined;
  return { speed: say.speedRel, pitch: say.pitch, emotion: say.emotion ?? undefined, gap_after: say.gap_after };
}

async function voiceClip(item, clip, dir) {
  const p = join(dir, `${clip.name}.mp3`);
  const marker = join(dir, `${clip.name}.txt`);
  const profile = VOICES[item.voice] || VOICES["clone-zh"];
  // 念的是 tts(带 <#x#> 停顿标记),字幕用的是 text。念法变了也要重合成,
  // 所以指纹里带上 say —— 光比文本会留下参数改了但音频没换的鬼音。
  const spoken = clip.tts || clip.text;
  const d = delivery(profile, clip.say);
  const fingerprint = JSON.stringify([spoken, d.speed, d.pitch, d.emotion ?? "", TTS_MODEL]);
  const stale = !existsSync(p) || !existsSync(marker) || readFileSync(marker, "utf8") !== fingerprint;
  if (stale) {
    writeFileSync(p, await tts(spoken, profile, clip.say));
    writeFileSync(marker, fingerprint);
  }
  return {
    path: p,
    dur: await ffprobeDur(p),
    gap: d.gap,
    say: { speed: d.speed, speedRel: clamp(clip.say?.speed, 0.7, 1.4, 1), pitch: d.pitch, emotion: d.emotion ?? null, gap_after: d.gap },
  };
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
  const warn = [];
  if (!out.hook || out.hook.length < 6) warn.push("钩子太短或缺失");
  const banned = /最|彻底|史上|百分百|绝对/.test(`${out.hook} ${(out.claims||[]).join(" ")}`) ;
  if (banned) warn.push("出现了绝对化用词(最/彻底/史上…),她审的时候重点看");
  const warnLine = warn.length ? `\n⚠ 选题自检:${warn.join(";")}` : "";
  return { note: note + warnLine, topic: out };
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
  // 停顿标记只该出现在 tts 里:漏进 text 会被念进字幕,tts 改了字就不是她的稿子了
  for (const c of out.clips) {
    c.text = String(c.text ?? "").replace(/<#[\d.]+#>/g, "");
    if (c.tts && String(c.tts).replace(/<#[\d.]+#>/g, "") !== c.text) c.tts = undefined;
  }
  const narration = out.narration || out.clips.map((c) => c.text).join("\n");
  const chars = out.clips.reduce((n, c) => n + c.text.length, 0);
  const arc = out.clips.map((c) => c.beat).filter(Boolean).join("→");
  const rel = out.clips.map((c) => Number(c.say?.speed) || 1);
  const swarn = [];
  if (Math.max(...rel) - Math.min(...rel) < 0.12) swarn.push("每拍的语速几乎一样,配音会像念经");
  if (!out.clips.some((c) => /<#[\d.]+#>/.test(String(c.tts || "")))) swarn.push("全片没标一处停顿");
  if ((out.clips[0]?.text || "").length > 20) swarn.push(`第一句 ${out.clips[0].text.length} 字,开头太长抓不住人`);
  return {
    script: narration,
    clips: out.clips,
    note: `${out.clips.length} 拍(${arc || "无节拍标注"}),约 ${chars} 字(目标 ~${item.duration}s)。连贯性/人味已经过一遍主编审稿。
念法:${out.clips.map((c) => `${c.name} ${(Number(c.say?.speed) || 1).toFixed(2)}x${c.say?.emotion ? `/${c.say.emotion}` : ""}`).join("  ")}${swarn.length ? `\n⚠ 脚本自检:${swarn.join(";")}` : ""}`,
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
    // 视觉审稿循环(只对新设计):渲出来 → 视觉模型按教案挑毛病 → 有问题改内容重渲。
    // 最后一关是硬闸:若 QA 仍说"知识内容用了纯文字卡",强制换结构化卡型。
    let passes = freshDesign ? 2 : 1;
    let lastIssues = [];
    for (let pass = 1; pass <= passes; pass++) {
      await renderCard(content, size, png);
      if (!freshDesign) break;
      const qa = await reviewImage(
        png,
        `审这张短视频画面卡(口播:"${clip.text}")。清单:1)第一眼是否落在主信息上 2)文字有没有溢出/被裁切/挤出画面 3)底部 17% 字幕安全区有没有被占用 4)有没有错别字/多字漏字 5)卡内容和口播是否相关 6)信息量:如果这卡只有一句短话的大字、而这拍讲的是知识/关系/对比内容,就是不达标(该用关系图/对照表/步骤链)`,
      );
      if (qa.ok || pass === passes) { lastIssues = qa.ok ? [] : qa.issues || []; break; }
      console.log(`  [footage] ${clip.name} QA 打回:${qa.issues?.join(";")} → 重设计`);
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `上一版被视觉审稿打回:${qa.issues?.join(";")}。针对问题改,返回同样结构的 JSON。` }],
        { temperature: 0.4 },
      );
    }
    // 硬闸:知识/关系/对比内容不许落在纯文字卡(开头钩子问句除外)
    const isHook = (clip.beat || "") === "hook" || i === 0;
    const infoIssue = lastIssues.some((x) => /信息量|大字|结构/.test(String(x)));
    if (freshDesign && content && content.type === "text" && infoIssue && !isHook) {
      console.log(`  [footage] ${clip.name} 硬闸:知识内容仍是 text 卡 → 强制结构化`);
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `两版了还是纯文字大字卡,不合格。禁止用 text,必须从 diagram / table / flow 里选一种,把这拍的关系/对照/流程画出来。返回同样结构的 JSON。` }],
        { temperature: 0.3 },
      );
      if (content.type === "text") content.type = "diagram";
      await renderCard(content, size, png);
    }
    console.log(`  [footage] ${clip.name} rendered, animating…`);
    const webm = join(dir, `${clip.name}.webm`);
    await renderCardVideo(content, size, 12, webm);
    const { url } = await upload(item.projectId, png, `card-${clip.name}.png`);
    const { url: animUrl } = await upload(item.projectId, webm, `card-${clip.name}.webm`);
    console.log(`  [footage] ${clip.name} rendered+animated, uploaded`);
    images.push(url);
    cards.push({ name: clip.name, text: clip.text, anim: animUrl, ...content });
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
    const { path: p, dur, gap, say } = await voiceClip(item, c, dir);
    console.log(`  [voice] ${c.name} ${dur.toFixed(1)}s @${say.speed.toFixed(2)}x pitch${say.pitch >= 0 ? "+" : ""}${say.pitch} ${say.emotion ?? "auto"} gap${gap}`);
    meta.push({ name: c.name, text: c.text, tts: c.tts || c.text, dur, gap, say, file: p });
  }
  // preview: one mp3 she can listen to straight through
  const preview = join(dir, "preview.mp3");
  const inputs = meta.flatMap((m) => ["-i", m.file]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,apad,atrim=0:${(m.dur + m.gap).toFixed(3)}[a${i}]`).join(";");
  const concat = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[a]`;
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concat, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "4", preview]);
  const { url } = await upload(item.projectId, preview, "voice-preview.mp3");
  // waveform image for the editor's audio track (like an NLE timeline)
  const wave = join(dir, "voice-wave.png");
  await ffmpeg(["-i", preview, "-filter_complex", "showwavespic=s=1800x140:colors=#e8622c", "-frames:v", "1", wave]);
  const { url: waveUrl } = await upload(item.projectId, wave, "voice-wave.png");
  const total = meta.reduce((n, m) => n + m.dur + m.gap, 0);
  const dev = Math.abs(total - item.duration) / item.duration;
  const warn = [];
  if (dev > 0.3) warn.push(`配音总长偏离目标 ${Math.round(dev * 100)}%(目标 ~${item.duration}s)`);
  const longClip = meta.find((m) => m.dur > 20);
  if (longClip) warn.push(`${longClip.name} 太长(${longClip.dur.toFixed(1)}s),可能念不过来`);
  // 念经自检:整片语速挤在一起 / 没人停顿 = 平。这是这条片子最常见的死法。
  const speeds = meta.map((m) => m.say.speed);
  const spread = Math.max(...speeds) - Math.min(...speeds);
  if (spread < 0.12) warn.push(`整片语速几乎没变化(最快 ${Math.max(...speeds).toFixed(2)}x / 最慢 ${Math.min(...speeds).toFixed(2)}x),听起来会像念经`);
  const paused = meta.filter((m) => /<#[\d.]+#>/.test(m.tts)).length;
  if (paused === 0) warn.push("全片没有一处句中停顿,钩子和数字砸不下去");
  const flat = meta.filter((m, i) => i > 0 && Math.abs(m.say.speed - meta[i - 1].say.speed) < 0.03 && m.say.emotion === meta[i - 1].say.emotion);
  if (flat.length >= 2) warn.push(`${flat.map((m) => m.name).join("/")} 和上一拍念法完全一样`);
  const warnLine = warn.length ? `\n⚠ 配音自检:${warn.join(";")}` : "";
  const sayLine = meta
    .map((m) => `${m.name} ${m.dur.toFixed(1)}s @${m.say.speed.toFixed(2)}x${m.say.pitch ? ` pitch${m.say.pitch > 0 ? "+" : ""}${m.say.pitch}` : ""}${m.say.emotion ? ` ${m.say.emotion}` : ""}${/<#[\d.]+#>/.test(m.tts) ? " ⏸" : ""}`)
    .join("\n");
  return {
    audio: url,
    wave: waveUrl,
    voiceMeta: { clips: meta.map(({ name, text, tts, dur, gap, say }) => ({ name, text, tts, dur, gap, say })), gap: GAP },
    note: `音色 ${profile.voice_id} 基准 ${profile.speed}x(${TTS_MODEL}),共 ${total.toFixed(1)}s(${meta.length} 句)。
每拍的念法(语速是基准的倍数,⏸ = 句中有停顿):
${sayLine}
节奏够不够、哪拍该快该慢,请审听——打回时直接点名"第3拍太平/开头再快点",下一版照着改。${warnLine}`,
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
    if (cm.anim) {
      const p = join(cardsDir, `${cm.name}.webm`);
      if (!existsSync(p)) await download(cm.anim, p);
      visuals.push({ kind: "anim", path: p });
    } else if (cm.asset) {
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
    // m 来自 voiceMeta,带着当时的 tts 文本和念法 —— 重新生成必须用同一套,
    // 不然补出来的那一拍念法和其他拍对不上。
    if (!existsSync(p)) await voiceClip(item, { ...m, say: sayToInput(m.say) }, voiceDir);
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
    const segDur = meta[i].dur + (meta[i].gap ?? GAP);
    const frames = Math.ceil(segDur * fps);
    const seg = join(dir, `seg-${meta[i].name}.mp4`);
    if (visuals[i].kind === "video" || visuals[i].kind === "anim") {
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
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,volume=5dB,apad,atrim=0:${(m.dur + (m.gap ?? GAP)).toFixed(3)}[a${i}]`).join(";");
  const concatF = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[av]`;
  const voiceM4a = join(dir, "voice.m4a");
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concatF, "-map", "[av]", voiceM4a]);

  // 4) mux (+ optional BGM bed)
  const out = join(dir, "edit.mp4");
  const bgmFile = item.bgm === "yes" ? readdirSafe(join(process.cwd(), "worker", "bgm")).find((f) => f.endsWith(".mp3")) : null;
  if (bgmFile) {
    const total = meta.reduce((n, m) => n + m.dur + (m.gap ?? GAP), 0);
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
  const expected = meta.reduce((n, m) => n + m.dur + (m.gap ?? GAP), 0);
  const info = await ffprobeInfo(out);
  const vs = (info.streams || []).find((x) => x.codec_type === "video") || {};
  const warn = [];
  if (Math.abs(total - expected) > 1.5) warn.push(`成片 ${total.toFixed(1)}s 与音轨预期 ${expected.toFixed(1)}s 对不上`);
  if (Number(vs.width) !== W || Number(vs.height) !== H) warn.push(`分辨率 ${vs.width}x${vs.height} ≠ ${W}x${H}`);
  const warnLine = warn.length ? `\n⚠ 剪辑自检:${warn.join(";")}` : "";
  return {
    video: url,
    note: `粗剪 ${total.toFixed(1)}s,${visuals.length} 拍${bgmFile ? "(带 BGM 垫底)" : "(无 BGM)"}。节奏/画面对位请审。${warnLine}`,
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
      overlays.push({ png, text: l, start: t, end: t + seg });
      t += seg;
    }
    offset += m.dur + (m.gap ?? gap);
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
  const warn = [];
  if (!overlays.length) warn.push("一行字幕都没有");
  const lastEnd = overlays.length ? overlays.at(-1).end : 0;
  const vidDur = await ffprobeDur(out);
  if (overlays.length && vidDur - lastEnd > 3) warn.push(`结尾 ${(vidDur - lastEnd).toFixed(1)}s 没有字幕`);
  const warnLine = warn.length ? `\n⚠ 字幕自检:${warn.join(";")}` : "";
  return {
    video: url,
    subs: overlays.map((o) => ({ text: o.text, start: o.start, end: o.end })),
    note: `字幕已烧录(${overlays.length} 行)。错字/断句/位置请审。${warnLine}`,
  };
}

async function polish(item) {
  const video = item.upstream?.subtitles?.video || item.upstream?.edit?.video;
  if (!video) throw new Error("上游没有成片视频");

  // ── 成片自动体检(学 MuseDock visualQaService):画幅/时长/黑屏/冻结/抽帧总评 ──
  const dir = workDir(item, "polish");
  const local = join(dir, "final.mp4");
  if (!existsSync(local)) await download(video, local);
  const qa = { issues: [] };
  try {
    const info = await ffprobeInfo(local);
    const dur = Number(info.format?.duration || 0);
    const stream = (info.streams || []).find((s) => s.codec_type === "video") || {};
    qa.durationSec = Math.round(dur * 10) / 10;
    qa.targetSec = item.duration;
    qa.deviationPct = Math.round((Math.abs(dur - item.duration) / item.duration) * 100);
    const wantW = item.aspect === "16:9" ? 1920 : 1080;
    const wantH = item.aspect === "16:9" ? 1080 : item.aspect === "3:4" ? 1440 : 1920;
    qa.aspectOk = Number(stream.width) === wantW && Number(stream.height) === wantH;
    if (!qa.aspectOk) qa.issues.push(`画幅 ${stream.width}x${stream.height},应为 ${wantW}x${wantH}`);
    if (qa.deviationPct > 25) qa.issues.push(`时长偏离目标 ${qa.deviationPct}%(>${25}%)`);

    const black = await ffmpegOut(["-i", local, "-vf", "blackdetect=d=0.6:pix_th=0.10", "-an", "-f", "null", "-"]);
    qa.blackIntervals = (black.match(/black_start:/g) || []).length;
    if (qa.blackIntervals > 0) qa.issues.push(`检测到 ${qa.blackIntervals} 段疑似黑屏(>0.6s)`);

    const freeze = await ffmpegOut(["-i", local, "-vf", "freezedetect=n=-60dB:d=2", "-an", "-f", "null", "-"]);
    qa.freezeIntervals = (freeze.match(/freeze_start:/g) || []).length;
    if (qa.freezeIntervals > 0) qa.issues.push(`检测到 ${qa.freezeIntervals} 段画面冻结(>2s)`);

    // 抽 3 帧给视觉模型做总评
    const picks = [0.15, 0.5, 0.85];
    const frames = [];
    for (let i = 0; i < picks.length; i++) {
      const f = join(dir, `qa-f${i}.png`);
      await ffmpeg(["-ss", String(Math.max(0.1, dur * picks[i])), "-i", local, "-frames:v", "1", f]);
      frames.push(f);
    }
    const vision = await reviewFrames(
      frames,
      "这是一条短视频成片的 3 个抽样帧(开头/中间/结尾)。总评:1)有没有明显翻车(黑屏/花屏/文字糊成一团) 2)画面是否像真人认真剪的(有信息结构),还是敷衍的模板感 3)帧之间风格是否一致",
    );
    qa.vision = vision;
    if (!vision.ok) qa.issues.push(...(vision.issues || []));
  } catch (e) {
    qa.error = e.message;
  }
  const qaLine = qa.error
    ? `体检没跑成:${qa.error}`
    : `体检:${qa.aspectOk ? "画幅✓" : "画幅✗"} · ${qa.durationSec}s/目标${qa.targetSec}s(偏差${qa.deviationPct}%) · 黑屏${qa.blackIntervals} · 冻结${qa.freezeIntervals} · AI总评${qa.vision?.ok === false ? "有问题" : "通过"}`;

  return {
    video,
    qa,
    note: `${qaLine}\n要微调(节奏/某句/某画面)就打回写批注;满意就通过,进入交付打包。${qa.issues.length ? "\n⚠ " + qa.issues.join(" / ") : ""}`,
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
  const coverQa = await reviewImage(png, "审这张短视频封面:1)主标题 0.5 秒内能不能读清 2)文字有没有被裁/溢出 3)有没有低俗震惊体感");
  const warnLine = coverQa.ok ? "" : `\n⚠ 封面自检:${(coverQa.issues || []).join(";")}`;
  return {
    cover: coverUrl,
    caption,
    note: `封面 + 抖音文案。通过后自动打包(视频+封面+文案 zip)可下载。${warnLine}`,
  };
}

export const STAGES = { topic, script, footage, voice, edit, subtitles, polish, deliver };
