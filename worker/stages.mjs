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
const GAP = 0.18; // 两拍之间的留白(秒)。原来 0.25,叠上 TTS 自带的空白就太长了

// When she rejects a stage with a note, the note must steer the redo —
// append it to whatever prompt the stage was going to send.
function guided(item, messages) {
  if (!item.reviewNote) return messages;
  const out = messages.map((m) => ({ ...m }));
  out[out.length - 1].content += `\n\n【打回批注——必须针对这条改,不是重做】${item.reviewNote}`;
  return out;
}

// LLM 常把表演提示写进台词:"(停顿)""(轻笑)""（深呼吸）" —— TTS 会照着念出来。
// 名单学自 MuseDock server/services/tts/speechText.js。
const STAGE_DIRECTIONS = [
  "吸气", "深呼吸", "停顿", "稍停顿", "短暂停顿", "稍作停顿", "沉默片刻",
  "轻笑", "苦笑", "冷笑", "叹气", "长叹一口气", "语速加快", "语速放慢", "加重语气", "放轻声音",
];
const CJK_DIRECTION_RE = new RegExp(`[（(]\\s*(?:${STAGE_DIRECTIONS.join("|")})\\s*[)）]`, "g");
const ASCII_DIRECTION_RE = /\[\s*(?:pause|breath|inhale|laugh|sigh)\s*\]/gi;

export function stripStageDirections(value) {
  return String(value ?? "")
    .replace(CJK_DIRECTION_RE, "")
    .replace(ASCII_DIRECTION_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
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
    // LLM 偶尔把倍率写成负数(实见 speed: -1.02),取绝对值再夹,不然这拍会莫名变慢
    speed: Number(clamp(profile.speed * clamp(Math.abs(Number(say.speed)), 0.8, 1.15, 1), 0.7, 1.6, profile.speed).toFixed(2)),
    pitch: Math.round(clamp(say.pitch, -6, 6, 0)),
    emotion: EMOTIONS.has(say.emotion) ? say.emotion : undefined,
    // 句间留白封在 0.35:真人讲话的句间停顿就是 0.2-0.35s,再长就断气了
    gap: clamp(say.gap_after, 0.05, 0.35, 0.18),
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
      // 字级时间戳:MiniMax 自己知道每个字什么时候念的,比我们按字数估准得多
      // —— 尤其现在台词里有 <#x#> 停顿,估算会整行歪掉。
      subtitle_enable: true,
      subtitle_type: "word",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.base_resp?.status_code !== 0) {
    throw new Error(`minimax: ${JSON.stringify(j?.base_resp || j).slice(0, 200)}`);
  }
  return { audio: Buffer.from(j.data.audio, "hex"), words: await fetchWordTimings(j?.data?.subtitle_file) };
}

// 字幕文件是一个临时 OSS 链接,拿不到就算了 —— 字幕会退回按字数估算,不至于整拍失败。
async function fetchWordTimings(url) {
  if (!url || !/^https:/.test(url)) return null;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const segs = Array.isArray(j) ? j : [j];
    const words = segs
      .flatMap((sg) => sg?.timestamped_words || [])
      .map((w) => [String(w.word ?? ""), Math.round(Number(w.time_begin) || 0), Math.round(Number(w.time_end) || 0)])
      .filter((w) => w[0]);
    return words.length ? words : null;
  } catch (e) {
    console.log(`  [voice] 字级时间戳没拿到(${String(e.message).slice(0, 60)}),这拍字幕按字数估算`);
    return null;
  }
}

// voiceMeta 里存的是算完的绝对值(speed 已经乘过基准);voiceClip 收的是相对倍率,
// 所以补生成时要把它换算回去,否则会再乘一次基准。
function sayToInput(say) {
  if (!say) return undefined;
  return { speed: say.speedRel, pitch: say.pitch, emotion: say.emotion ?? undefined, gap_after: say.gap_after };
}

async function voiceClip(item, clip, dir, tag = "") {
  const p = join(dir, `${clip.name}${tag}.mp3`);
  const marker = join(dir, `${clip.name}${tag}.txt`);
  const profile = VOICES[item.voice] || VOICES["clone-zh"];
  // 念的是 tts(带 <#x#> 停顿标记),字幕用的是 text。念法变了也要重合成,
  // 所以指纹里带上 say —— 光比文本会留下参数改了但音频没换的鬼音。
  // 句首的 <#x#> 会和上一拍的句尾留白叠加(实测叠出过 1.07s 的大坑),剥掉它 ——
  // 停顿该由 gap 统一表达,一处一个来源。
  const spoken = stripStageDirections(clip.tts || clip.text).replace(/^\s*<#[\d.]+#>/, "");
  const d = delivery(profile, clip.say);
  const fingerprint = JSON.stringify([spoken, d.speed, d.pitch, d.emotion ?? "", TTS_MODEL]);
  const wordsFile = join(dir, `${clip.name}${tag}.words.json`);
  const stale = !existsSync(p) || !existsSync(marker) || readFileSync(marker, "utf8") !== fingerprint;
  if (stale) {
    const { audio, words } = await tts(spoken, profile, clip.say);
    writeFileSync(p, audio);
    if (words) writeFileSync(wordsFile, JSON.stringify(words));
    writeFileSync(marker, fingerprint);
  }
  let rawWords = null;
  try { rawWords = JSON.parse(readFileSync(wordsFile, "utf8")); } catch { rawWords = null; }

  // 每拍首尾都有 TTS 自带的空白,再叠上句尾留白,两拍之间就拖成半秒以上 ——
  // 听起来就是"一句一句念的",不像一次录下来的。字级时间戳给了准确的人声起止,
  // 按它把两头收紧(尾部只留 0.08s 收尾,头部空白整个裁掉)。
  const raw = await ffprobeDur(p);
  const lastEnd = rawWords?.length ? rawWords[rawWords.length - 1][2] / 1000 : null;
  const firstStart = rawWords?.length ? rawWords[0][1] / 1000 : 0;
  // 句首空白 > 0.12s 才裁 —— 再小就是正常起音,裁了反而像被切头
  const head = firstStart > 0.12 ? Number((firstStart - 0.06).toFixed(3)) : 0;
  const tailKeep = 0.08;
  const dur = lastEnd != null ? Number((Math.min(lastEnd + tailKeep, raw) - head).toFixed(3)) : raw - head;
  if (head > 0 || (lastEnd != null && raw - lastEnd > 0.2)) {
    console.log(`  [voice] ${clip.name} 收边:头 -${head.toFixed(2)}s 尾 -${lastEnd != null ? (raw - lastEnd - tailKeep).toFixed(2) : "0"}s → ${dur.toFixed(2)}s`);
  }
  return {
    path: p,
    dur,
    gap: d.gap,
    head,
    // 裁了头,字幕的时间戳要跟着平移,不然整拍字幕晚 head 秒
    words: rawWords?.map(([w, b, e]) => [w, Math.max(0, b - Math.round(head * 1000)), Math.max(0, e - Math.round(head * 1000))]) ?? null,
    say: { speed: d.speed, speedRel: clamp(Math.abs(Number(clip.say?.speed)), 0.8, 1.15, 1), pitch: d.pitch, emotion: d.emotion ?? null, gap_after: d.gap },
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
  // 停顿标记只该出现在 tts 里:漏进 text 会被念进字幕,tts 改了字就不是她的稿子了。
  // 舞台提示同理 —— LLM 爱写"(停顿)""(轻笑)"进台词,TTS 会把这三个字念出来。
  for (const c of out.clips) {
    c.text = stripStageDirections(String(c.text ?? "").replace(/<#[\d.]+#>/g, ""));
    if (c.tts) {
      c.tts = stripStageDirections(String(c.tts));
      if (c.tts.replace(/<#[\d.]+#>/g, "") !== c.text) c.tts = undefined;
    }
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
        const pInfo = await ffprobeInfo(local);
        const pvs = (pInfo.streams || []).find((st) => st.codec_type === "video") || {};
        // 预览图走和成片同一套进画规则,免得网页上看着好好的、片子里被裁了
        await ffmpeg(["-ss", "0.5", "-i", local, "-frames:v", "1", "-vf", fitChain(size.width, size.height, pvs.width, pvs.height).chain, poster]);
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
    let layoutIssues = [];
    for (let pass = 1; pass <= passes; pass++) {
      const rendered = await renderCard(content, size, png);
      layoutIssues = rendered.layout || [];
      if (!freshDesign) break;
      // 排版毛病在浏览器里量出来了,视觉模型只管好不好看(它数不准像素)
      const qa = await reviewImage(
        png,
        `审这张短视频画面卡(口播:"${clip.text}")。清单:1)第一眼是否落在主信息上 2)有没有错别字/多字漏字 3)卡内容和口播是否相关 4)信息量:如果这卡只有一句短话的大字、而这拍讲的是知识/关系/对比内容,就是不达标(该用关系图/对照表/步骤链)。排版溢出不用你管,已经量过了。`,
      );
      const issues = [...layoutIssues, ...(qa.ok ? [] : qa.issues || [])];
      if (!issues.length || pass === passes) { lastIssues = issues; break; }
      console.log(`  [footage] ${clip.name} 打回:${issues.join(";")} → 重设计`);
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `上一版被打回:${issues.join(";")}。针对问题改(文字太长就删字,别指望缩字号),返回同样结构的 JSON。` }],
        { temperature: 0.4 },
      );
    }
    if (layoutIssues.length) console.log(`  [footage] ${clip.name} 排版仍有:${layoutIssues.join(";")}`);
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
      layoutIssues = (await renderCard(content, size, png)).layout || [];
    }
    console.log(`  [footage] ${clip.name} rendered, animating…`);
    const webm = join(dir, `${clip.name}.webm`);
    await renderCardVideo(content, size, 12, webm);
    const { url } = await upload(item.projectId, png, `card-${clip.name}.png`);
    const { url: animUrl } = await upload(item.projectId, webm, `card-${clip.name}.webm`);
    console.log(`  [footage] ${clip.name} rendered+animated, uploaded`);
    images.push(url);
    cards.push({ name: clip.name, text: clip.text, anim: animUrl, layout: layoutIssues.length ? layoutIssues : undefined, ...content });
  }
  await closeBrowser();
  const assetCount = cards.filter((c) => c.asset).length;
  // 全片卡型雷同自检(学 MuseDock 的 low_visual_variety / card_like_layout_overuse):
  // 单张卡都合格、六张摆一起像同一张图的六个版本 —— 这是最常见的"像 PPT"来源。
  const designed = cards.filter((c) => !c.asset);
  const kinds = new Set(designed.map((c) => c.type || "text"));
  const sameness = [];
  if (designed.length >= 3 && kinds.size < 3) sameness.push(`${designed.length} 张设计卡只有 ${kinds.size} 种卡型(${[...kinds].join("/")}),整片会像 PPT`);
  for (const k of kinds) {
    const n = designed.filter((c) => (c.type || "text") === k).length;
    if (designed.length >= 4 && n / designed.length >= 0.6) sameness.push(`${k} 卡占了 ${n}/${designed.length}`);
  }
  const adjacent = designed.filter((c, i) => i > 0 && (c.type || "text") === (designed[i - 1].type || "text"));
  if (adjacent.length) sameness.push(`${adjacent.map((c) => c.name).join("/")} 和上一拍同型`);
  return {
    images,
    cards,
    note: `${images.length} 拍画面(${item.aspect})${assetCount ? `,其中 ${assetCount} 拍用了你的真素材` : ""}。卡型:${designed.map((c) => `${c.name} ${c.type || "text"}`).join("  ")}
画面和台词是否对得上,请审。${
      cards.filter((c) => c.layout?.length).length
        ? `\n⚠ 排版自检:${cards.filter((c) => c.layout?.length).map((c) => `${c.name} ${c.layout.join("/")}`).join(";")}`
        : ""
    }${sameness.length ? `\n⚠ 雷同自检:${sameness.join(";")}` : ""}`,
  };
}

// 念法从哪来:脚本阶段标好的最好。老项目没标,或者她打回说"太平/开头再快点",
// 就在这儿补一遍 —— 只动念法,台词一个字不改(改完对不上就丢掉那拍的 tts)。
async function withDelivery(item, clips) {
  // 2026-09-15 生产事故:这里原来写的是 clips.every(...),意思是"全部拍都没念法才补"。
  // 聊天里插入一句新台词(chat-ops.ts 的 insert_after)不会带 say,如果其它拍都有 say,
  // every() 判定为"不缺",这一拍就带着 say=undefined 流进 smoothPitch/capPitchRange,
  // 两边都直接读 c.say.pitch,当场崩掉整个配音阶段。改成 some():只要有一拍缺,就补。
  const missing = clips.some((c) => !c.say);
  if (!missing && !item.reviewNote) return clips;
  console.log(`  [voice] ${missing ? "有拍没标念法" : "按打回批注重标念法"},让 LLM 标一遍(不改台词)`);
  let out;
  try {
    out = await chatJSON(guided(item, PROMPTS.delivery(item, clips)), { temperature: 0.5, maxTokens: 3000 });
  } catch (e) {
    console.log(`  [voice] 标念法失败(${e.message?.slice(0, 80)}),缺的那几拍给默认念法兜底`);
    out = null;
  }
  const byName = new Map((out?.clips || []).map((c) => [c.name, c]));
  return clips.map((c) => {
    const d = byName.get(c.name);
    // 兜底:LLM 没标这拍(没返回/漏了名字/整个调用失败)、且这拍本来就没 say,
    // 给一个空对象而不是留 undefined —— 下游全靠 say.xxx 这样直接取值,
    // undefined 会让整个配音阶段崩掉,空对象走 delivery() 的默认值就没事。
    if (!d) return c.say ? c : { ...c, say: {} };
    const tts = typeof d.tts === "string" && d.tts.replace(/<#[\d.]+#>/g, "") === c.text ? d.tts : undefined;
    return { ...c, tts: tts ?? c.tts, say: d.say || c.say || {} };
  });
}

// B 版 = 同一份稿子"再冲一点"的念法:整体快一档、亮一档、留白短一档。
// 不是随机换参数 —— 是给她一个明确的方向选择(稳 vs 冲),选完了才知道这条片该往哪走。
function punchier(say = {}) {
  // calm 是特意留给转折/落点"沉下来"制造对比的,B 版整体更冲不该把它拉回 fluent
  // (那是彻底没表情,比 calm 更平)—— 直接推到 surprised,反差更足。
  // fluent 本来就是"没表情"的兜底档,B 版没理由继续沉默,直接推成 happy。
  const emotion = say.emotion === "calm" ? "surprised" : say.emotion === "fluent" ? "happy" : say.emotion;
  return {
    ...say,
    speed: Math.min(1.15, (Number(say.speed) || 1) * 1.08),
    pitch: Math.min(3, Math.round(Number(say.pitch) || 0) + 1),
    emotion,
    gap_after: Math.max(0.05, Number((((Number(say.gap_after) || 0.25) * 0.78)).toFixed(2))),
  };
}

// 合成一整版配音(一个 take):逐拍 TTS → 拼成一条能从头听到尾的 mp3 → 出波形图。
// ── 全片一次合成,再切回每拍 ──────────────────────────────────────────
// 2026-09-15 她连续听出配音"像换了人":查过 MiniMax 接口文档,它不支持一次调用里
// 逐句变语气,也没有跨调用保持音色的机制——12 次独立调用之间的音色漂移是接口
// 本身的限制,不是参数没调好。测过:分开调用最大接缝跳变 4+ 个半音;整段一次生成,
// 同样时间跨度的天然漂移只有 0-1 个半音。改法:一条稿子一次 tts() 调用,
// 拍与拍之间靠 <#x#> 停顿标记断句,合成完按字级时间戳切回每拍单独的文件——
// 下游 ensureInputs/edit/subtitles 还是按"每拍一个文件"读,不用跟着大改。
// 代价:每拍不再有独立的语速/音高/情绪,整条片统一一套念法(她已经听过这个
// 效果并确认"很好了")。gap_after 和句中停顿标记还是按拍设计,保留了节奏起伏。
const TAKE_BASE_SAY = { speed: 0.94, pitch: 1, emotion: "happy", gap_after: 0.2 }; // 落在她确认过的 ~1.18x

async function synthesizeWholeTake(item, staged, dir, tag, takeSay) {
  const profile = VOICES[item.voice] || VOICES["clone-zh"];
  const clean = (c) => stripStageDirections(c.tts || c.text).replace(/^\s*<#[\d.]+#>/, "");
  const texts = staged.map(clean);
  const parts = [];
  staged.forEach((c, i) => {
    parts.push(texts[i]);
    if (i < staged.length - 1) {
      const gap = clamp(c.say?.gap_after, 0.05, 0.8, TAKE_BASE_SAY.gap_after);
      parts.push(`<#${gap.toFixed(2)}#>`);
    }
  });
  const joined = parts.join("");
  const d = delivery(profile, takeSay);

  const wholeFile = join(dir, `whole${tag}.mp3`);
  const wordsFile = join(dir, `whole${tag}.words.json`);
  const marker = join(dir, `whole${tag}.txt`);
  const fingerprint = JSON.stringify([joined, d.speed, d.pitch, d.emotion ?? "", TTS_MODEL]);
  const stale = !existsSync(wholeFile) || !existsSync(marker) || readFileSync(marker, "utf8") !== fingerprint;
  let rawWords;
  if (stale) {
    console.log(`  [voice]${tag ? " B" : " A"} 整段合成中(${joined.length} 字)…`);
    const { audio, words } = await tts(joined, profile, takeSay);
    writeFileSync(wholeFile, audio);
    if (words) writeFileSync(wordsFile, JSON.stringify(words));
    writeFileSync(marker, fingerprint);
    rawWords = words;
  } else {
    try { rawWords = JSON.parse(readFileSync(wordsFile, "utf8")); } catch { rawWords = null; }
  }
  if (!rawWords?.length) throw new Error("整段配音没拿到字级时间戳,没法切回每拍(字幕/剪辑都靠它对齐)");

  // 按累计字符数切,不能按条目数切:MiniMax 会把重复标点合并成一个词条
  // (比如"！！"是一条,占 2 个字符),按条目数切会systematic地偏移。
  const results = [];
  let wi = 0;
  for (let ci = 0; ci < staged.length; ci++) {
    const target = [...texts[ci]].length;
    let acc = 0;
    const startWi = wi;
    while (wi < rawWords.length && acc < target) {
      acc += [...rawWords[wi][0]].length;
      wi++;
    }
    results.push(rawWords.slice(startWi, wi));
  }

  const meta = [];
  for (let i = 0; i < staged.length; i++) {
    const cw = results[i];
    const p = join(dir, `${staged[i].name}${tag}.mp3`);
    const gap = clamp(staged[i].say?.gap_after, 0.05, 0.8, TAKE_BASE_SAY.gap_after);
    if (!cw.length) {
      // 这拍一个字都没分到(极端情况,比如空文本):留一段极短静音兜底,别让整段崩掉
      await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=32000:cl=mono", "-t", "0.3", p]);
      meta.push({ name: staged[i].name, beat: staged[i].beat, text: staged[i].text, tts: staged[i].tts || staged[i].text, dur: 0.3, gap, head: 0, words: [], say: { speed: d.speed, speedRel: 1, pitch: d.pitch, emotion: d.emotion ?? null, gap_after: gap }, file: p });
      continue;
    }
    const startMs = cw[0][1];
    const endMs = cw[cw.length - 1][2];
    const startSec = Math.max(0, startMs / 1000 - 0.02);
    const dur = Number(((endMs - startMs) / 1000 + 0.08).toFixed(3)); // +0.08 收尾余韵,和原来逐拍合成的口径一致
    // -ss 放在 -i 之后精确解码切,不用前置快速 seek(对切点精度要求高——
    // 下游剪辑的转场、时长自检都靠这个数字)
    await ffmpeg(["-i", wholeFile, "-ss", startSec.toFixed(3), "-t", dur.toFixed(3), "-c:a", "libmp3lame", "-q:a", "4", p]);
    const words = cw.map(([w, b, e]) => [w, Math.max(0, b - startMs), Math.max(0, e - startMs)]);
    meta.push({
      name: staged[i].name, beat: staged[i].beat, text: staged[i].text, tts: staged[i].tts || staged[i].text,
      dur, gap, head: 0, words,
      say: { speed: d.speed, speedRel: clamp(Math.abs(Number(staged[i].say?.speed)), 0.8, 1.15, 1), pitch: d.pitch, emotion: d.emotion ?? null, gap_after: gap },
      file: p,
    });
  }
  console.log(`  [voice]${tag ? " B" : " A"} 切回 ${meta.length} 拍,合计 ${meta.reduce((n, m) => n + m.dur, 0).toFixed(1)}s @${d.speed.toFixed(2)}x pitch${d.pitch >= 0 ? "+" : ""}${d.pitch} ${d.emotion ?? "auto"}`);
  return meta;
}

async function renderTake(item, staged, dir, tag, fileBase, takeSay) {
  const meta = await synthesizeWholeTake(item, staged, dir, tag, takeSay);
  const preview = join(dir, `${fileBase}.mp3`);
  const inputs = meta.flatMap((m) => ["-i", m.file]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,atrim=${(m.head ?? 0).toFixed(3)}:${((m.head ?? 0) + m.dur).toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${m.gap.toFixed(3)}[a${i}]`).join(";");
  const concat = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[a]`;
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concat, "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "4", preview]);
  const { url } = await upload(item.projectId, preview, `${fileBase}.mp3`);
  const wave = join(dir, `${fileBase}-wave.png`);
  await ffmpeg(["-i", preview, "-filter_complex", "showwavespic=s=1800x140:colors=#e8622c", "-frames:v", "1", wave]);
  const { url: waveUrl } = await upload(item.projectId, wave, `${fileBase}-wave.png`);
  const total = meta.reduce((n, m) => n + m.dur + m.gap, 0);
  return { url, waveUrl, total, meta };
}




async function voice(item) {
  const clips = item.upstream?.script?.clips;
  if (!clips?.length) throw new Error("上游脚本没有 clips");
  const dir = workDir(item, "voice");
  const profile = VOICES[item.voice] || VOICES["clone-zh"];
  // withDelivery 仍然有用:老项目/打回批注时补一遍 gap_after 和句中停顿标记 ——
  // 这两样还是按拍设计的,决定节奏起伏。speed/pitch/emotion 三个字段现在只是
  // 历史遗留(界面/日志里还会显示),真正合成用的是下面统一的 TAKE_BASE_SAY,
  // 原因见 synthesizeWholeTake 的注释。
  const staged = await withDelivery(item, clips);

  // 出两版让她挑。配音是这条片里最难用规则定死的一步,给两个方向让她听完点一个。
  const takeA = await renderTake(item, staged, dir, "", "voice-preview", TAKE_BASE_SAY);
  const takeB = await renderTake(item, staged, dir, "-b", "voice-preview-b", punchier(TAKE_BASE_SAY));

  const meta = takeA.meta;
  const dev = Math.abs(takeA.total - item.duration) / item.duration;
  const warn = [];
  if (dev > 0.3) warn.push(`配音总长偏离目标 ${Math.round(dev * 100)}%(目标 ~${item.duration}s)`);
  const longClip = meta.find((m) => m.dur > 20);
  if (longClip) warn.push(`${longClip.name} 太长(${longClip.dur.toFixed(1)}s),切分可能不准`);
  const paused = meta.filter((m) => /<#[\d.]+#>/.test(m.tts)).length;
  if (paused === 0) warn.push("全片没有一处句中停顿,钩子和数字砸不下去");
  const emptyClip = meta.find((m) => !m.words?.length);
  if (emptyClip) warn.push(`${emptyClip.name} 没分到任何字,切分可能出错,建议打回重出`);
  const warnLine = warn.length ? `\n⚠ 配音自检:${warn.join(";")}` : "";

  const pick = ({ name, beat, text, tts, dur, gap, say, words, head }) => ({ name, beat, text, tts, dur, gap, say, words, head });
  const sayA = delivery(profile, TAKE_BASE_SAY);
  const sayB = delivery(profile, punchier(TAKE_BASE_SAY));
  return {
    audio: takeA.url,
    wave: takeA.waveUrl,
    // tag 标记这一版的每拍音频文件用的后缀(A 版不带后缀,B 版 "-b") ——
    // ensureInputs 靠它找到磁盘上正确的文件。她在网页上切换 A/B 时,
    // voiceMeta/voiceMetaAlt 整个对调,tag 跟着一起换,不用额外同步。
    voiceMeta: { clips: meta.map(pick), gap: GAP, tag: "" },
    takes: {
      a: { label: "稳一点", audio: takeA.url, wave: takeA.waveUrl, total: Number(takeA.total.toFixed(1)) },
      b: { label: "冲一点", audio: takeB.url, wave: takeB.waveUrl, total: Number(takeB.total.toFixed(1)) },
      picked: "a",
    },
    voiceMetaAlt: { clips: takeB.meta.map(pick), gap: GAP, tag: "-b" },
    note: `音色 ${profile.voice_id}(${TTS_MODEL})。整条片一次生成,不再分拍单独调用 ——
MiniMax 不支持一次调用里逐句变语气,分开调用之间又没有保持音色一致的机制,
拆开合成会漏出接缝(2026-09-15 实测最大跳变 4+ 个半音)。现在的代价是没有
逐拍的语速/音高变化了,起伏靠停顿和句间留白撑。
A 稳一点 @${sayA.speed.toFixed(2)}x ${sayA.emotion} ${takeA.total.toFixed(1)}s / B 冲一点 @${sayB.speed.toFixed(2)}x ${sayB.emotion} ${takeB.total.toFixed(1)}s。
两版都不对就打回,说清楚是"整体太平"还是"某几拍断句不对"。${warnLine}`,
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
  // voiceMeta.tag 标出这一版用的文件后缀(A 版 "",B 版 "-b")—— 整段一次合成之后,
  // 每拍的音频已经从同一次生成里切好了,只需要按 tag 找到对应文件,不用重新调 TTS。
  // 只有文件真的不在(工作目录被清过这种极端情况)才退回单独合成一拍兜底,
  // 兜底出来的这一拍音色会和其它拍略有差异(独立调用没有连续性保证),但好过整段崩掉。
  const tag = up.voice?.voiceMeta?.tag ?? "";
  const voices = [];
  for (const m of meta || []) {
    const p = join(voiceDir, `${m.name}${tag}.mp3`);
    if (!existsSync(p)) {
      console.log(`  [edit] ${m.name}${tag} 的配音文件丢了,单独补一拍兜底(音色可能和其它拍有细微差异)`);
      await voiceClip(item, { ...m, say: sayToInput(m.say) }, voiceDir, tag);
    }
    voices.push(p);
  }
  return { visuals, voices, meta };
}

// ── 运镜:每拍不能都是同一个缓慢推近 ──────────────────────────────────
// 原来所有画面都套 z='1+0.10*on/N'(居中匀速推近)。同一个动作重复 6-12 遍,
// 就是最容易被认出来的"AI 做的视频"。按节拍分配不同的运镜,并且硬性要求
// 相邻两拍不一样 —— 和配音那边"相邻两拍念法不能一样"是同一条规矩。
const CAM_X = "iw/2-(iw/zoom/2)";
const CAM_Y = "ih/2-(ih/zoom/2)";
const CAM_MOVES = {
  pushIn: (n) => ({ z: `1+0.11*on/${n}`, x: CAM_X, y: CAM_Y }),
  pushSoft: (n) => ({ z: `1+0.06*on/${n}`, x: CAM_X, y: CAM_Y }),
  pullOut: (n) => ({ z: `1.11-0.10*on/${n}`, x: CAM_X, y: CAM_Y }),
  panRight: (n) => ({ z: "1.07", x: `(iw-iw/zoom)*on/${n}`, y: CAM_Y }),
  panLeft: (n) => ({ z: "1.07", x: `(iw-iw/zoom)*(1-on/${n})`, y: CAM_Y }),
  driftUp: (n) => ({ z: "1.08", x: CAM_X, y: `(ih-ih/zoom)*(1-on/${n})` }),
  hold: () => ({ z: "1.015", x: CAM_X, y: CAM_Y }),
};
// 每个节拍的候选,按优先级;取第一个和上一拍不同的
const CAM_BY_BEAT = {
  hook: ["pushIn", "panRight"],
  context: ["panRight", "driftUp", "pushSoft"],
  evidence: ["driftUp", "pushSoft", "panLeft"],
  turn: ["pullOut", "hold"],
  landing: ["hold", "pushSoft"],
};
const CAM_FALLBACK = ["pushSoft", "panRight", "driftUp", "pullOut", "hold", "panLeft"];

function pickCamera(beat, index, prev) {
  const candidates = CAM_BY_BEAT[beat] || [CAM_FALLBACK[index % CAM_FALLBACK.length], ...CAM_FALLBACK];
  return candidates.find((c) => c !== prev) || candidates[0];
}

// ── 转场:硬切是"幻灯片感"的主要来源 ──────────────────────────────
// 但也不能每刀都花哨 —— 一条 6-12 拍的片子只配 1-2 个重转场,其余用短交叉淡化,
// 否则转场本身变成噪音。重转场留给叙事真正拐弯的地方(turn / landing)。
const SOFT_CUT = { type: "fade", dur: 0.22 };
const STRONG_CUTS = { turn: { type: "smoothleft", dur: 0.38 }, landing: { type: "smoothup", dur: 0.34 } };
const MAX_STRONG_CUTS = 2;

function planTransitions(meta) {
  const out = [];
  let strong = 0;
  for (let i = 1; i < meta.length; i++) {
    const beat = meta[i].beat;
    const want = STRONG_CUTS[beat];
    if (want && strong < MAX_STRONG_CUTS) {
      out.push({ ...want, into: meta[i].name });
      strong += 1;
    } else {
      out.push({ ...SOFT_CUT, into: meta[i].name });
    }
  }
  return out;
}

// ── 素材视频进画:不裁掉功能,也不硬循环 ─────────────────────────────
// 1) 画幅对不上就"整幅放进去",背后垫一层它自己的模糊放大版当底。原来的
//    force_original_aspect_ratio=increase + crop 是中心裁切:一段 3:4 的录屏
//    进 9:16 会被切掉左右各 12.5%,分数、右侧按钮这些功能直接不见(2026-09-16
//    「遇见正缘」c01 就是这么废的)。
// 2) 素材比这一拍短就先放慢(最多 1.5 倍),还不够就正放+倒放接龙(首尾同帧,
//    没有跳切),都不行才冻最后一帧。原来的 -stream_loop -1 是硬循环,4.2 秒
//    的录屏在 11.5 秒的一拍里转 2.7 圈,一眼就看出来是凑时长。
const FIT_TOLERANCE = 0.08; // 宽高比差在 8% 以内,照旧铺满裁切(切掉的是边角,不是内容)
const MAX_SLOWDOWN = 1.5;   // 再慢就不像正常操作了
const MAX_REVERSIBLE = 20;  // reverse 要把整段读进内存,长素材不走接龙

function evenPx(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

// 返回一段可以直接接在 -vf 里的滤镜(含标签分支),外加一句人话说明用了哪种进画方式。
function fitChain(W, H, srcW, srcH) {
  const tAR = W / H;
  const sAR = srcW && srcH ? srcW / srcH : tAR;
  if (Math.abs(sAR - tAR) / tAR <= FIT_TOLERANCE) {
    return { chain: `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`, mode: "铺满裁切" };
  }
  const bw = evenPx(W / 4), bh = evenPx(H / 4); // 先缩小再模糊再放大,比直接糊 1080p 快一个量级
  const fw = evenPx(W * 0.94), fh = evenPx(H * 0.94); // 留一点内缩,模糊底才像是设计过的
  return {
    chain:
      "split=2[bg][fg];" +
      `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `boxblur=luma_radius=${Math.floor(Math.min(bw, bh) / 12)}:luma_power=2,` +
      `eq=brightness=-0.10:saturation=0.7,scale=${W}:${H},setsar=1[bgb];` +
      `[fg]scale=${fw}:${fh}:force_original_aspect_ratio=decrease,setsar=1[fgs];` +
      "[bgb][fgs]overlay=(W-w)/2:(H-h)/2",
    mode: "整幅放进去+模糊底",
  };
}

// 把一段素材视频(或动画卡 webm)渲成正好 segDur 长的一拍。
// setsar=1 是关键:素材如果带着非方形像素的 SAR/DAR 元数据(实见她的一个上传素材),
// scale+crop 完全不会清掉这个标签,原样传到成片,变成"编码 1080x1920、播放器按
// 5040x1920 显示"——横向被拉成宽屏。
export async function renderAssetSeg(src, out, { W, H, fps, segDur }) {
  const info = await ffprobeInfo(src);
  const vs = (info.streams || []).find((s) => s.codec_type === "video") || {};
  const srcDur = parseFloat(info.format?.duration) || 0;
  const { chain, mode } = fitChain(W, H, vs.width, vs.height);
  const notes = [mode];

  let input = src;
  let speed = 1;
  let hold = 0;
  let loop = false;
  if (srcDur > 0.1 && srcDur < segDur - 0.05) {
    speed = Math.min(MAX_SLOWDOWN, segDur / srcDur);
    if (speed > 1.02) notes.push(`放慢 ${speed.toFixed(2)}x`);
    if (srcDur * speed < segDur - 0.05) {
      if (srcDur <= MAX_REVERSIBLE) {
        // 正放 + 倒放接成一段:接缝两端是同一帧,循环起来没有跳切。
        // trim=start_frame=1 去掉倒放重复的那一帧。
        input = out.replace(/\.mp4$/, "-pp.mp4");
        await ffmpeg([
          "-i", src, "-filter_complex",
          "[0:v]split=2[f][r];[r]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[f][rv]concat=n=2:v=1:a=0[v]",
          "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", input,
        ]);
        loop = true;
        notes.push(`正倒放接龙 ${(segDur / (2 * srcDur * speed)).toFixed(1)} 轮`);
      } else {
        hold = segDur - srcDur * speed;
        notes.push(`冻最后一帧 ${hold.toFixed(1)}s`);
      }
    }
  }

  const vf = [
    ...(speed > 1.02 ? [`setpts=${speed.toFixed(4)}*PTS`] : []),
    ...(hold > 0.05 ? [`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`] : []),
    chain, `fps=${fps}`, "format=yuv420p",
  ].join(",");

  await ffmpeg([
    ...(loop ? ["-stream_loop", "-1"] : []), "-i", input, "-t", segDur.toFixed(3),
    "-vf", vf, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", out,
  ]);
  return notes.join(" / ");
}

async function edit(item) {
  const { visuals, voices, meta } = await ensureInputs(item);
  if (!visuals.length || visuals.length !== voices.length) throw new Error("画面和配音数量对不上");
  const { width: W, height: H } = sizeFor(item.aspect);
  const dir = workDir(item, "edit");
  const fps = 30;

  // 1) per-clip video segments: 静态画面按节拍给不同运镜;录屏裁切铺满
  const segs = [];
  let lastMove = null;
  const cameraLog = [];
  // 第 i 段要多渲一个转场的时长,给下一刀当重叠料;xfade 吃掉的正好是多出来的部分,
  // 所以成片总长仍然等于 Σ(每拍时长 + 句尾留白),音轨不用动。
  const trans = planTransitions(meta);
  for (let i = 0; i < visuals.length; i++) {
    const beatDur = meta[i].dur + (meta[i].gap ?? GAP);
    const segDur = beatDur + (trans[i] ? trans[i].dur : 0);
    const frames = Math.ceil(segDur * fps);
    const seg = join(dir, `seg-${meta[i].name}.mp4`);
    let assetNote = "";
    if (visuals[i].kind === "video" || visuals[i].kind === "anim") {
      assetNote = await renderAssetSeg(visuals[i].path, seg, { W, H, fps, segDur });
    } else {
      const move = pickCamera(meta[i].beat, i, lastMove);
      lastMove = move;
      cameraLog.push(`${meta[i].name} ${move}`);
      const m = CAM_MOVES[move](frames);
      const zoom = `scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${W}x${H}:fps=${fps},setsar=1,format=yuv420p`;
      await ffmpeg(["-loop", "1", "-framerate", String(fps), "-t", segDur.toFixed(3), "-i", visuals[i].path, "-vf", zoom, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", seg]);
    }
    console.log(`  [edit] seg ${meta[i].name} ${segDur.toFixed(1)}s done (${visuals[i].kind}${assetNote ? ", " + assetNote : ""}${lastMove ? ", " + lastMove : ""})`);
    segs.push(seg);
  }

  // 2) 串起来:一刀一个 xfade(offset 用"到这拍为止的累计时长",不含重叠)
  const videoOnly = join(dir, "video-only.mp4");
  if (segs.length === 1) {
    await ffmpeg(["-i", segs[0], "-c", "copy", videoOnly]);
  } else {
    const inputs = segs.flatMap((s) => ["-i", s]);
    let offset = 0;
    const chain = trans.map((t, i) => {
      offset += meta[i].dur + (meta[i].gap ?? GAP);
      const src = i === 0 ? "[0:v]" : `[x${i}]`;
      const dst = i === trans.length - 1 ? "[vout]" : `[x${i + 1}]`;
      // offset = 转场开始的时刻,也就是"到这拍为止的累计时长"。
      // 每段多渲了一个转场的料,所以这一刻正好是上一段多出来那截的开头。
      return `${src}[${i + 1}:v]xfade=transition=${t.type}:duration=${t.dur}:offset=${offset.toFixed(3)}${dst}`;
    }).join(";");
    await ffmpeg([...inputs, "-filter_complex", chain, "-map", "[vout]", "-c:v", "libx264", "-crf", "19", "-preset", "fast", "-pix_fmt", "yuv420p", videoOnly]);
  }
  console.log(`  [edit] 转场:${trans.map((t) => `${t.into} ${t.type}`).join("  ")}`);

  // 3) voice track: each clip padded to its segment length, then concat
  const inputs = voices.flatMap((v) => ["-i", v]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,volume=5dB,atrim=${(m.head ?? 0).toFixed(3)}:${((m.head ?? 0) + m.dur).toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${(m.gap ?? GAP).toFixed(3)}[a${i}]`).join(";");
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
    note: `粗剪 ${total.toFixed(1)}s,${visuals.length} 拍${bgmFile ? "(带 BGM 垫底)" : "(无 BGM)"}。${cameraLog.length ? `运镜:${cameraLog.join("  ")}` : ""}${trans.length ? `\n转场:${trans.map((t) => `${t.into} ${t.type}`).join("  ")}` : ""}
节奏/画面对位请审。${warnLine}`,
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

// 有字级时间戳时,行就按真实发声时间断:一行的起止取首尾字的时间,
// 停顿天然落在两行之间 —— 按字数估算做不到这点。
function linesFromWords(words, maxChars = 14) {
  const BREAK = /[，。！？、；：,.!?;:]/;
  const lines = [];
  let cur = null;
  for (const [w, b, e] of words) {
    const isPunct = BREAK.test(w);
    if (!isPunct) {
      if (!cur) cur = { text: "", start: b / 1000, end: e / 1000 };
      cur.text += w;
      cur.end = e / 1000;
    } else if (cur) {
      cur.end = Math.max(cur.end, b / 1000);
    }
    if (cur && (isPunct || [...cur.text].length >= maxChars)) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur) lines.push(cur);
  // 断出来的碎片(1-3 字)并进上一行,别让字幕一闪一个字
  const merged = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && ([...l.text].length <= 3 || [...prev.text].length <= 3) && [...(prev.text + l.text)].length <= maxChars + 4) {
      prev.text += l.text;
      prev.end = l.end;
    } else merged.push(l);
  }
  return merged.filter((l) => l.text && l.end > l.start);
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
  let byWords = 0;
  for (const m of meta) {
    // 首选 MiniMax 给的字级时间戳;老项目没有就退回按字数估算
    const timed = Array.isArray(m.words) && m.words.length ? linesFromWords(m.words) : null;
    if (timed?.length) {
      byWords += 1;
      for (const l of timed) {
        const png = join(dir, `line-${String(overlays.length).padStart(3, "0")}.png`);
        await renderSubLine(l.text, size, png);
        overlays.push({ png, text: l.text, start: offset + l.start, end: offset + Math.min(l.end, m.dur) });
      }
    } else {
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
  const timing = byWords === meta.length ? "跟着人声逐字对齐" : byWords ? `${byWords}/${meta.length} 拍逐字对齐,其余按字数估算` : "按字数估算(这条片没有字级时间戳)";
  return {
    video: url,
    subs: overlays.map((o) => ({ text: o.text, start: o.start, end: o.end })),
    note: `字幕已烧录(${overlays.length} 行,${timing})。错字/断句/位置请审。${warnLine}`,
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
  const coverRender = await renderCard({ kicker: "", big: cov.main, sub: cov.sub, type: "text" }, size, png);
  if (coverRender.layout?.length) console.log(`  [deliver] 封面排版:${coverRender.layout.join(";")}`);
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
