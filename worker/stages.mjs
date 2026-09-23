// The eight stage executors. Each takes the poll item (project + upstream
// artifacts) and returns the artifacts patch to submit for review.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chatJSON, reviewImage, reviewFrames } from "./llm.mjs";
import { PROMPTS } from "./prompts.mjs";
import { renderCard, renderCardVideo, renderSubLine, sizeFor, closeBrowser } from "./cards.mjs";
import { ffmpeg, ffprobeDur, ffprobeInfo, ffmpegOut, ffmpegRaw, ensureDisk } from "./ffmpeg.mjs";
import { upload, downloadCached } from "./board.mjs";
import { startCall, endCall } from "./calls.mjs";
import { cached, fileSha } from "./segcache.mjs";
import { planReveal, spokenIndex } from "./reveal.mjs";
import { drawCard, drawReady, DRAWABLE } from "./draw.mjs";
import { detectRegions, planFocus, focusCamKeys } from "./focus.mjs";
import { planSfx, renderSfxTrack, sfxReady } from "./sfx.mjs";
import { validateScript, validateDelivery, validateCard, validateTopic, validateCover, validateCaption, repairDecisions } from "./validate.mjs";
import { footageShots } from "./footage-shots.mjs";
import { shotsReady, shotsVersion, renderBeat, renderCam } from "./remotion/render.mjs";
import { timeShots, spokenIndex as shotIndex } from "../shots/timing.mjs";
import { TPL_LABEL, normalizeShots, SCENE_ON } from "./shots.mjs";
import { sceneImage, sceneKey, dataUrl } from "./images.mjs";

export const WORK_ROOT = process.env.WORK_DIR || join(process.cwd(), "data", "work");
const GAP = 0.18; // 两拍之间的留白(秒)。原来 0.25,叠上 TTS 自带的空白就太长了
const TAIL_HOLD = 1.3; // 片尾最后一个字之后留多久
const TAIL_FADE = 0.7; // 最后多少秒淡出(画面和声音一起)
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"; // 响度 -16 LUFS / 峰值 -1.5 dBTP(ops-bilibili finish.sh)
// 画面里不许出现网址(2026-09-23 起所有平台):台词、镜头上的字、文案、封面都查
export const URL_RE = /(https?:\/\/|www\.|[a-z0-9-]{2,}\.(com|cn|net|org|io|cc|app|me|co)(\b|\/))/i;

// ── 决定清单用的小工具 ──────────────────────────────────────────────
// 每个阶段产出时同时交一份 decisions:这一步替她做了哪些决定、为什么。
// 以前这些决定(裁掉 25% 画面、循环 2.7 圈、字幕烧在哪一版粗剪上)只存在于日志里,
// 她只能看完成片往回猜。

// 标记当前在做哪一拍、哪一步 —— 失败或超时时 index.mjs 靠它说清卡在哪
// 也是取消点:她改了需求(阶段被重新排队)或者超时了,index.mjs 会设 item.cancelled,
// 下一步开始前就停 —— 不再把一整版按旧需求做完、传完再作废,也不会超时后在后台接着覆盖文件。
function mark(item, beat, step) {
  if (item.cancelled) {
    const e = new Error(item.cancelled === "timeout" ? "超时了,停在这一步" : "需求改了,这一版作废");
    e.cancelled = item.cancelled;
    throw e;
  }
  if (!item.progress) return;
  item.progress.beat = beat || undefined;
  item.progress.step = step || undefined;
}

// 上传并把进度写进 item.progress.upload —— 心跳会把它带给网页("上传成片 60%")
async function uploadP(item, path, name, label = "上传") {
  if (item.progress) item.progress.upload = { label, sent: 0, total: 0 };
  try {
    return await upload(item.projectId, path, name, 1, (sent, total) => {
      if (item.progress) item.progress.upload = { label, sent, total };
    });
  } finally {
    if (item.progress) item.progress.upload = null;
  }
}

// 带版本的文件名:同名覆盖会让旧版的链接指到新内容上,"版本"就看不了旧的了
const stamp = () => Date.now().toString(36);

// 审核用的小文件:上行只有 ~80KB/s,1080p 成片 19MB 要传 4 分钟;720p、码率压低之后约 1/5。
// 高清版留在渲染机上(下一步直接用),到润色阶段才整条传一次。
async function makePreview(src, out, aspect) {
  const [pw, ph] = aspect === "16:9" ? [1280, 720] : aspect === "3:4" ? [720, 960] : [720, 1280];
  await ffmpeg(["-i", src, "-vf", `scale=${pw}:${ph}:flags=bicubic`, "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]);
  return out;
}

// 高清母版按内容哈希存成 master-<sha>.mp4(下一步凭哈希认领,旧版本留最近 4 份,版本对比/退回用得上)
async function keepMaster(file, dir, prefix) {
  const { fileSha } = await import("./segcache.mjs");
  const sha = await fileSha(file);
  const dest = join(dir, `${prefix}-master-${sha.slice(0, 12)}.mp4`);
  const { renameSync, statSync, unlinkSync } = await import("node:fs");
  renameSync(file, dest);
  const old = readdirSafe(dir)
    .filter((f) => f.startsWith(`${prefix}-master-`) && f.endsWith(".mp4"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(4);
  for (const o of old) unlinkSync(join(dir, o.f));
  return { path: dest, sha, bytes: statSync(dest).size };
}

/** 上一步留在本机的高清母版;找不到(换了机器/被清理)就退回下载预览,并说明画质会差 */
async function localMaster(item, up, dir, name) {
  const { fileSha } = await import("./segcache.mjs");
  const m = up?.master;
  if (m?.path && existsSync(m.path)) {
    try {
      if ((await fileSha(m.path)) === m.sha) return { path: m.path, fromPreview: false };
    } catch {
      /* 读不了就下载 */
    }
  }
  if (!up?.video) throw new Error("上一步没有视频");
  mark(item, null, "下载上一步的视频");
  return { path: await downloadCached(up.video, join(dir, name)), fromPreview: !!up.preview };
}

// 产物 URL 上的 ?v=<毫秒时间戳> 就是它的版本 —— 清单里写明下游吃的是哪一版上游
function vtime(url) {
  const m = String(url || "").match(/[?&]v=(\d{12,})/);
  if (!m) return null;
  return new Date(Number(m[1])).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
function latestV(urls) {
  let best = null;
  for (const u of urls || []) {
    const m = String(u || "").match(/[?&]v=(\d{12,})/);
    if (m && (!best || Number(m[1]) > Number(best[1]))) best = m;
  }
  return best ? vtime(`?v=${best[1]}`) : null;
}
function arLabel(w, h) {
  if (!w || !h) return "?";
  const g = (a, b) => (b ? g(b, a % b) : a);
  const d = g(w, h);
  return w / d <= 32 && h / d <= 32 ? `${w / d}:${h / d}` : (w / h).toFixed(2);
}
const pct = (x) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
const s1 = (x) => `${Number(x).toFixed(1)}s`;
const CARD_TYPES = { text: "文字卡", data: "数字卡", diagram: "关系图", table: "对照表", flow: "流程图", contrast: "对比卡", step: "步骤卡", quote: "引语卡" };
const BEAT_LABEL = { hook: "钩子", context: "铺垫", evidence: "论据", turn: "转折", landing: "落点" };
const CAM_LABEL = { none: "不加运镜", pushIn: "推近", pushSoft: "轻推", pullOut: "拉远", panRight: "右摇", panLeft: "左摇", driftUp: "上移", hold: "几乎不动", pullSoft: "轻拉", pushMicro: "微推" };
function speedLabel(v) {
  return Math.abs(v - 1) < 0.02 ? "原速" : v > 1 ? `放慢 ${v.toFixed(2)}x` : `加速 ${(1 / v).toFixed(2)}x`;
}

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
  const rec = startCall("tts", `${TTS_MODEL} · ${profile.voice_id}`, { text, params: { speed: d.speed, pitch: d.pitch, emotion: d.emotion } });
  const r = await fetch(base, {
    signal: AbortSignal.timeout(180_000), // 整段合成也就几十秒;挂住的连接别拖到阶段超时
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
  const ok = j?.base_resp?.status_code === 0;
  const audioBytes = ok ? Math.round(String(j.data?.audio ?? "").length / 2) : 0;
  if (!ok) {
    endCall(rec, { httpStatus: r.status, status: "error", response: JSON.stringify(j?.base_resp || j).slice(0, 2000) });
    throw new Error(`minimax: ${JSON.stringify(j?.base_resp || j).slice(0, 200)}`);
  }
  const words = await fetchWordTimings(j?.data?.subtitle_file);
  endCall(rec, {
    httpStatus: r.status,
    status: "ok",
    response: `音频 ${(audioBytes / 1024).toFixed(0)} KB · 字级时间戳 ${words?.length ?? 0} 个${words?.length ? `(最后一个字结束于 ${(words.at(-1)[2] / 1000).toFixed(2)}s)` : ",没拿到"}`,
    usage: j?.extra_info,
  });
  return { audio: Buffer.from(j.data.audio, "hex"), words };
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
  mark(item, null, "想选题");
  const out = await chatJSON(guided(item, PROMPTS.topic(item)), { temperature: 0.8 }, validateTopic);
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
  const decisions = [
    { topic: "目标", choice: `~${item.duration}s · ${item.aspect}`, why: "项目设置里定的,后面脚本字数按它估" },
    { topic: "钩子", choice: `${[...String(out.hook || "")].length} 字`, why: "开头一句,决定前 3 秒留不留得住人", warn: !out.hook || out.hook.length < 6 },
    { topic: "要讲的", choice: `${(out.claims || []).length} 条`, why: "脚本只能讲这几条,讲不到的就是没选上" },
  ];
  if (banned) decisions.push({ topic: "用词", choice: "有绝对化用词", why: "最/彻底/史上/百分百/绝对 —— 平台容易判违规", warn: true });
  if (item.reviewNote) decisions.push({ topic: "批注", choice: "按你的打回批注重写", why: item.reviewNote.slice(0, 80) });
  decisions.push(...repairDecisions(out, "选题"));
  const material = item.artifacts?.material;
  if (material) decisions.push({ topic: "参考材料", choice: `${[...material].length} 字`, why: "新建项目时贴的资料,选题和脚本都基于它写" });
  // 参考材料跟着选题往下传:脚本阶段只看得到上游的产物
  return { note: note + warnLine, topic: material ? { ...out, material } : out, decisions };
}

// 中文口播实测 4.5-4.7 字/秒(含句间留白,不算标点)—— 两条线上片子量出来的。
// 以前脚本阶段只在提示词里说一句"约 N 字",LLM 写多了没人管:「遇见正缘」目标 90s,
// 写了 630 字,成片 135s。现在超预算 15% 就让它压,压两轮还超就标黄。
const CHARS_PER_SEC = 4.6;
export const spokenLen = (s) => [...String(s ?? "").replace(/[\p{P}\p{S}\s]/gu, "")].length;

// 停顿标记只该出现在 tts 里:漏进 text 会被念进字幕,tts 改了字就不是她的稿子了。
// 舞台提示同理 —— LLM 爱写"(停顿)""(轻笑)"进台词,TTS 会把这三个字念出来。
function tidyClips(clips) {
  const stripped = [];
  const ttsDropped = [];
  clips.forEach((c, i) => { c.name = `c${String(i + 1).padStart(2, "0")}`; });
  for (const c of clips) {
    const raw = String(c.text ?? "").replace(/<#[\d.]+#>/g, "").trim();
    c.text = stripStageDirections(raw);
    if (c.text !== raw) stripped.push(c.name);
    if (c.tts) {
      c.tts = stripStageDirections(String(c.tts));
      if (c.tts.replace(/<#[\d.]+#>/g, "") !== c.text) { c.tts = undefined; ttsDropped.push(c.name); }
    }
  }
  return { stripped, ttsDropped };
}

async function script(item) {
  const t = item.upstream?.topic?.topic;
  if (!t) throw new Error("上游选题没有结构化数据(topic.topic 缺失)");
  // Two passes: draft the coherent narration, then a chief-editor critique.
  // Learned from MuseDock: narration is one flowing piece (hook→landing),
  // segmented into beats of 1-3 sentences — never a list of one-liners.
  const budget = Math.round(item.duration * CHARS_PER_SEC);
  mark(item, null, "写初稿");
  const draft = await chatJSON(guided(item, PROMPTS.script(item, t, budget)), { temperature: 0.75, maxTokens: 6000 }, validateScript);
  mark(item, null, "主编审稿");
  let out = await chatJSON(PROMPTS.scriptCritique(item, draft, budget), { temperature: 0.5, maxTokens: 6000 }, validateScript);
  const critiqueOut = out;
  if (!Array.isArray(out.clips) || out.clips.length < 3) throw new Error("脚本 clips 太少或格式错误");
  let { stripped, ttsDropped } = tidyClips(out.clips);
  const count = (o) => o.clips.reduce((n, c) => n + spokenLen(c.text), 0);
  const draftLen = Array.isArray(draft.clips) ? count(draft) : null;
  let n = count(out);
  const trims = [];
  const zh = item.voice !== "minimax-en"; // 英文稿按字数卡没意义
  for (let pass = 1; zh && pass <= 2 && n > budget * 1.15; pass++) {
    mark(item, null, `压字数(第 ${pass} 轮,${n} → ${budget} 字)`);
    const cut = await chatJSON(PROMPTS.scriptTrim(item, out, budget, n), { temperature: 0.4, maxTokens: 6000 }, validateScript).catch(() => null);
    if (!Array.isArray(cut?.clips) || cut.clips.length < 3) break;
    const tidy = tidyClips(cut.clips);
    const m = count(cut);
    if (m >= n) break; // 没压下来就别换
    trims.push([n, m]);
    out = cut;
    ({ stripped, ttsDropped } = tidy);
    n = m;
  }
  const narration = out.narration && !trims.length ? out.narration : out.clips.map((c) => c.text).join("\n");
  const chars = n;
  const arc = out.clips.map((c) => c.beat).filter(Boolean).join("→");
  const rel = out.clips.map((c) => Number(c.say?.speed) || 1);
  const swarn = [];
  if (Math.max(...rel) - Math.min(...rel) < 0.12) swarn.push("每拍的语速几乎一样,配音会像念经");
  if (!out.clips.some((c) => /<#[\d.]+#>/.test(String(c.tts || "")))) swarn.push("全片没标一处停顿");
  if ((out.clips[0]?.text || "").length > 20) swarn.push(`第一句 ${out.clips[0].text.length} 字,开头太长抓不住人`);

  const est = Math.round(chars / CHARS_PER_SEC);
  const over = zh && chars > budget * 1.15;
  const under = zh && chars < budget * 0.7;
  const decisions = [
    { topic: "拍数", choice: `${Array.isArray(draft.clips) ? `初稿 ${draft.clips.length} 拍 → ` : ""}定稿 ${out.clips.length} 拍`, why: "初稿写完过了一遍主编审稿(连贯性、人味),拍数以定稿为准" },
    {
      topic: "字数",
      choice: `${chars} 字 · 预估 ~${est}s`,
      why: `目标 ~${item.duration}s → 预算 ${budget} 字(不算标点,每秒 ${CHARS_PER_SEC} 字是两条线上片子实测的)${draftLen != null ? `;初稿 ${draftLen} 字` : ""}` +
        (over ? ";压了还是超,配音会比目标长,要么打回说删哪段,要么接受这个长度" : under ? ";偏短,配音会比目标短不少" : ""),
      warn: over || under,
    },
    ...trims.map(([a, b], i) => ({ topic: "压字数", choice: `第 ${i + 1} 轮 ${a} → ${b} 字`, why: "超预算 15% 以上,让 AI 删次要的例子和重复的意思,钩子和落点尽量不动" })),
    ...swarn.map((w) => ({ topic: "自检", choice: w, warn: true })),
    ...repairDecisions(draft, "初稿"),
    ...repairDecisions(critiqueOut, "审稿后的稿子"),
  ];
  if (item.reviewNote) decisions.unshift({ topic: "批注", choice: "按你的打回批注重写", why: item.reviewNote.slice(0, 80) });
  if (t.material) decisions.push({ topic: "参考材料", choice: "按你贴的资料写", why: `${[...t.material].length} 字的资料,数字和案例从这里出` });
  for (const c of out.clips) {
    const pauses = (String(c.tts || "").match(/<#[\d.]+#>/g) || []).length;
    decisions.push({ beat: c.name, topic: "节拍", choice: `${BEAT_LABEL[c.beat] ?? c.beat ?? "未标"} · ${spokenLen(c.text)} 字${pauses ? ` · 停顿 ${pauses} 处` : ""}` });
    if (stripped.includes(c.name)) decisions.push({ beat: c.name, topic: "清理", choice: "删掉了台词里的舞台提示", why: "像「(停顿)」这种字会被 TTS 照着念出来" });
    if (ttsDropped.includes(c.name)) decisions.push({ beat: c.name, topic: "停顿", choice: "没用 AI 标的停顿版", why: "标停顿时改了字,按原台词念(这拍就没有句中停顿了)", warn: true });
  }
  return {
    script: narration,
    clips: out.clips,
    decisions,
    note: `${out.clips.length} 拍(${arc || "无节拍标注"}),约 ${chars} 字(目标 ~${item.duration}s,预算 ${budget} 字)。连贯性/人味已经过一遍主编审稿。
念法:${out.clips.map((c) => `${c.name} ${(Number(c.say?.speed) || 1).toFixed(2)}x${c.say?.emotion ? `/${c.say.emotion}` : ""}`).join("  ")}${swarn.length ? `\n⚠ 脚本自检:${swarn.join(";")}` : ""}`,
  };
}

async function footage(item) {
  // 新做法:每拍 1-4 个动态镜头(worker/footage-shots.mjs)。渲染机没装镜头渲染器
  // (worker/remotion 下没跑过 npm install)或者显式关掉(SHOTS=off)才退回老字卡。
  if (process.env.SHOTS !== "off" && shotsReady()) return footageShots(item, { mark, workDir, sizeFor, stamp });
  return footageCards(item);
}

async function footageCards(item) {
  const clips = item.upstream?.script?.clips;
  if (!clips?.length) throw new Error("上游脚本没有 clips");
  const dir = workDir(item, "cards");
  const size = sizeFor(item.aspect);
  const assets = item.assets || [];
  // Reuse card designs from a previous pass for clips whose text is unchanged —
  // chat edits usually touch one line; regenerating all designs is waste.
  // 先按拍名找,找不到再按台词找:插一句/删一句之后后面的拍会整体改名。
  const prevCards = item.artifacts?.cards || [];
  const prevImages = item.artifacts?.images || [];
  const prevByName = new Map(prevCards.map((c, i) => [c.name, { ...c, _img: prevImages[i] }]));
  const prevByText = new Map(prevCards.map((c, i) => [c.text, { ...c, _img: prevImages[i] }]));
  const images = [];
  const cards = [];
  const decisions = [];
  const cardCheck = validateCard(assets.map((a) => a.name));
  if (item.reviewNote) decisions.push({ topic: "批注", choice: "每一拍都按你的批注重新设计", why: item.reviewNote.slice(0, 80) });
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const beat = clip.name;
    const designRepairs = [];
    const named = prevByName.get(clip.name);
    const prev = named && named.text === clip.text ? named : prevByText.get(clip.text) || named;
    // 画面简报被她改过(visualRev 变了)就不许沿用 —— 以前只比台词,「只改画面」会被默默忽略
    const sameVisual = !!prev && (prev.visualRev ?? 0) === (clip.visualRev ?? 0);
    // 素材优先:聊天指定的(clip.asset)> LLM 挑的 > 字卡
    let assetName = clip.asset || null;
    let assetBy = clip.asset ? "you" : null;
    let content = null;
    let freshDesign = false;
    let reused = false;
    let why = "";
    if (!assetName) {
      if (prev && !item.reviewNote && prev.text === clip.text && sameVisual && (prev.big || prev.asset)) {
        if (prev.asset) { assetName = prev.asset; assetBy = "reuse"; }
        else content = { type: prev.type, kicker: prev.kicker, big: prev.big, sub: prev.sub, foot: prev.foot, big2: prev.big2, step_no: prev.step_no };
        reused = true;
        why = "台词和画面简报都没变,沿用上一版的设计";
        console.log(`  [footage] ${clip.name} reuse ${assetName ? "asset " + assetName : "design"}`);
      } else {
        why = item.reviewNote ? "按你的打回批注重新设计"
          : !prev ? "这一拍第一次做"
          : prev.text !== clip.text ? "台词变了,重新设计"
          : !sameVisual ? "你改了画面简报,重新设计"
          : "上一版没有能沿用的设计";
        mark(item, beat, "设计画面");
        console.log(`  [footage] ${clip.name} designing…`);
        content = await chatJSON(guided(item, PROMPTS.card(item, clip, i, clips.length)), { temperature: 0.6 }, cardCheck);
        designRepairs.push(...repairDecisions(content, "画面设计", beat));
        freshDesign = true;
        if (content.asset && assets.some((a) => a.name === content.asset)) {
          assetName = content.asset;
          assetBy = "ai";
          content = null;
          freshDesign = false;
        }
      }
    }

    if (assetName) {
      const asset = assets.find((a) => a.name === assetName);
      if (!asset) throw new Error(`素材「${assetName}」不在素材库里(可能被删了),换一个或把这拍的指定去掉`);
      let posterUrl = asset.url;
      if (asset.kind === "video") {
        if (prev && prev.asset === assetName && prev.assetUrl === asset.url && prev.name === clip.name && prev._img) {
          posterUrl = prev._img; // 同一拍、同一个素材:封面帧不用重截重传
        } else {
          mark(item, beat, "截素材封面帧");
          // poster frame so the cards grid / timeline has something to show
          const local = await downloadCached(asset.url, join(workDir(item, "assets"), asset.name));
          const poster = join(dir, `${clip.name}-poster.png`);
          const pInfo = await ffprobeInfo(local);
          const pvs = (pInfo.streams || []).find((st) => st.codec_type === "video") || {};
          // 预览图走和成片同一套进画规则,免得网页上看着好好的、片子里被裁了
          await ffmpeg(["-ss", "0.5", "-i", local, "-frames:v", "1", "-vf", fitChain(size.width, size.height, pvs.width, pvs.height, clip.overrides?.fit).chain, poster]);
          mark(item, beat, "上传素材封面帧");
          const up = await upload(item.projectId, poster, `asset-${clip.name}-poster.png`);
          posterUrl = up.url;
        }
      }
      console.log(`  [footage] ${clip.name} uses asset ${assetName}`);
      images.push(posterUrl);
      cards.push({ name: clip.name, text: clip.text, asset: assetName, assetUrl: asset.url, visualRev: clip.visualRev });
      decisions.push({
        beat,
        topic: "画面",
        choice: `${asset.kind === "video" ? "录屏" : "图片"}「${assetName}」`,
        by: assetBy === "you" ? "you" : "auto",
        why: assetBy === "you" ? "你指定的(聊天或拖拽)" : assetBy === "ai" ? "AI 设计这拍时判断用你的素材比设计卡合适" : "上一版就用的这个素材,台词没变",
      });
      continue;
    }

    // 沿用的设计、同一个拍名、上一版的图和动画都在:直接用,不重渲不重传。
    // (拍名不同不能这么做:card-cXX 文件会被这次在 cXX 上新做的卡覆盖,旧 URL 指到的就不是它了)
    if (reused && prev.name === clip.name && prev.anim && prev._img) {
      const { _img, ...keep } = prev;
      images.push(_img);
      cards.push({ ...keep, name: clip.name, text: clip.text, visualRev: clip.visualRev });
      decisions.push({ beat, topic: "画面", choice: `${CARD_TYPES[prev.type] ?? prev.type ?? "设计卡"}(沿用)`, why: `${why};没有重新渲染` });
      console.log(`  [footage] ${clip.name} reuse render as-is`);
      continue;
    }

    const png = join(dir, `${clip.name}.png`);
    // 视觉审稿循环(只对新设计):渲出来 → 视觉模型按教案挑毛病 → 有问题改内容重渲。
    // 最后一关是硬闸:若 QA 仍说"知识内容用了纯文字卡",强制换结构化卡型。
    let passes = freshDesign ? 2 : 1;
    let lastIssues = [];
    let layoutIssues = [];
    const rejected = [];
    for (let pass = 1; pass <= passes; pass++) {
      mark(item, beat, pass === 1 ? "渲染画面卡" : "按审稿意见重渲");
      const rendered = await renderCard(content, size, png);
      layoutIssues = rendered.layout || [];
      if (!freshDesign) break;
      // 排版毛病在浏览器里量出来了,视觉模型只管好不好看(它数不准像素)
      mark(item, beat, "视觉审稿");
      const qa = await reviewImage(
        png,
        `审这张短视频画面卡(口播:"${clip.text}")。清单:1)第一眼是否落在主信息上 2)有没有错别字/多字漏字 3)卡内容和口播是否相关 4)信息量:如果这卡只有一句短话的大字、而这拍讲的是知识/关系/对比内容,就是不达标(该用关系图/对照表/步骤链)。排版溢出不用你管,已经量过了。`,
      );
      const issues = [...layoutIssues, ...(qa.ok ? [] : qa.issues || [])];
      if (!issues.length || pass === passes) { lastIssues = issues; break; }
      rejected.push(...issues);
      console.log(`  [footage] ${clip.name} 打回:${issues.join(";")} → 重设计`);
      mark(item, beat, "按审稿意见重设计");
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `上一版被打回:${issues.join(";")}。针对问题改(文字太长就删字,别指望缩字号),返回同样结构的 JSON。` }],
        { temperature: 0.4 },
        cardCheck,
      );
    }
    if (layoutIssues.length) console.log(`  [footage] ${clip.name} 排版仍有:${layoutIssues.join(";")}`);
    // 硬闸:知识/关系/对比内容不许落在纯文字卡(开头钩子问句除外)
    const isHook = (clip.beat || "") === "hook" || i === 0;
    const infoIssue = lastIssues.some((x) => /信息量|大字|结构/.test(String(x)));
    let forced = false;
    if (freshDesign && content && content.type === "text" && infoIssue && !isHook) {
      console.log(`  [footage] ${clip.name} 硬闸:知识内容仍是 text 卡 → 强制结构化`);
      mark(item, beat, "强制换结构化卡");
      content = await chatJSON(
        [...PROMPTS.card(item, clip, i, clips.length), { role: "user", content: `两版了还是纯文字大字卡,不合格。禁止用 text,必须从 diagram / table / flow 里选一种,把这拍的关系/对照/流程画出来。返回同样结构的 JSON。` }],
        { temperature: 0.3 },
        cardCheck,
      );
      if (content.type === "text") content.type = "diagram";
      layoutIssues = (await renderCard(content, size, png)).layout || [];
      forced = true;
    }
    decisions.push({ beat, topic: "画面", choice: `${reused ? "" : "新设计 · "}${CARD_TYPES[content.type] ?? content.type ?? "文字卡"}${reused ? "(沿用,重新渲染)" : ""}`, why });
    decisions.push(...designRepairs);
    if (rejected.length) decisions.push({ beat, topic: "审稿", choice: "视觉审稿打回 1 次,改过一版", why: rejected.join(";").slice(0, 140) });
    if (forced) decisions.push({ beat, topic: "审稿", choice: `强制换成${CARD_TYPES[content.type] ?? content.type}`, why: "两版都还是纯文字大字卡,而这拍讲的是知识内容", warn: true });
    if (layoutIssues.length) decisions.push({ beat, topic: "排版", choice: "还有排版问题没修掉", why: layoutIssues.join(";"), warn: true });
    console.log(`  [footage] ${clip.name} rendered, animating…`);
    mark(item, beat, "做入场动画");
    const webm = join(dir, `${clip.name}.webm`);
    await renderCardVideo(content, size, 12, webm);
    mark(item, beat, "上传画面卡");
    const { url } = await upload(item.projectId, png, `card-${clip.name}.png`);
    const { url: animUrl } = await upload(item.projectId, webm, `card-${clip.name}.webm`);
    console.log(`  [footage] ${clip.name} rendered+animated, uploaded`);
    images.push(url);
    cards.push({ name: clip.name, text: clip.text, anim: animUrl, visualRev: clip.visualRev, layout: layoutIssues.length ? layoutIssues : undefined, ...content });
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
  decisions.unshift(
    { topic: "构成", choice: `${designed.length} 张设计卡 · ${assetCount} 拍你的素材`, why: `卡型:${[...kinds].map((k) => CARD_TYPES[k] ?? k).join("、") || "无"}` },
    ...sameness.map((w) => ({ topic: "雷同", choice: w, warn: true })),
  );
  return {
    images,
    cards,
    decisions,
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
  const info = { asked: false, failed: false, defaulted: [], dropped: [], missing: clips.filter((c) => !c.say).map((c) => c.name) };
  if (!missing && !item.reviewNote) return { clips, info };
  console.log(`  [voice] ${missing ? "有拍没标念法" : "按打回批注重标念法"},让 LLM 标一遍(不改台词)`);
  info.asked = true;
  let out;
  try {
    mark(item, null, "补标念法");
    out = await chatJSON(guided(item, PROMPTS.delivery(item, clips)), { temperature: 0.5, maxTokens: 3000 }, validateDelivery(clips));
    info.repairs = repairDecisions(out, "补标的念法");
  } catch (e) {
    console.log(`  [voice] 标念法失败(${e.message?.slice(0, 80)}),缺的那几拍给默认念法兜底`);
    out = null;
    info.failed = true;
  }
  const byName = new Map((out?.clips || []).map((c) => [c.name, c]));
  const next = clips.map((c) => {
    const d = byName.get(c.name);
    // 兜底:LLM 没标这拍(没返回/漏了名字/整个调用失败)、且这拍本来就没 say,
    // 给一个空对象而不是留 undefined —— 下游全靠 say.xxx 这样直接取值,
    // undefined 会让整个配音阶段崩掉,空对象走 delivery() 的默认值就没事。
    if (!d) {
      if (!c.say) info.defaulted.push(c.name);
      return c.say ? c : { ...c, say: {} };
    }
    const tts = typeof d.tts === "string" && d.tts.replace(/<#[\d.]+#>/g, "") === c.text ? d.tts : undefined;
    if (typeof d.tts === "string" && !tts) info.dropped.push(c.name);
    return { ...c, tts: tts ?? c.tts, say: d.say || c.say || {} };
  });
  return { clips: next, info };
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

  // 按"字"切,不按条目数、也不按含标点的字符数切:MiniMax 会把标点合并或改写
  // (「！！」一条、「——」变成一个「—」),按字符数数的话每遇到一处就多吃下一拍一个字 ——
  // 2026-09-24 查出「遇见正缘」从第 2 拍起逐拍错位,到第 12 拍差 6 个字,音频切口落在「东|西」中间。
  // 只数汉字/字母/数字;标点跟在哪个字后面就归哪一拍(不让下一拍以标点开头)。
  const coreLen = (str) => [...String(str).replace(/<#[\d.]+#>/g, "")].filter((ch) => !/[\p{P}\p{S}\s]/u.test(ch)).length;
  const results = [];
  let wi = 0;
  for (let ci = 0; ci < staged.length; ci++) {
    const target = coreLen(texts[ci]);
    let acc = 0;
    const startWi = wi;
    while (wi < rawWords.length && acc < target) {
      acc += coreLen(rawWords[wi][0]);
      wi++;
    }
    while (wi < rawWords.length && coreLen(rawWords[wi][0]) === 0) wi++;
    results.push(rawWords.slice(startWi, wi));
  }
  // 自检:每拍切到的字和台词逐字一致(不一致说明切口落在词中间,剪辑和字幕都会错位)
  const coreStr = (str) => [...String(str).replace(/<#[\d.]+#>/g, "")].filter((ch) => !/[\p{P}\p{S}\s]/u.test(ch)).join("");
  const misaligned = staged.map((c, i) => (coreStr(results[i].map((w) => w[0]).join("")) === coreStr(c.text) ? null : c.name)).filter(Boolean);
  if (misaligned.length) console.log(`  [voice] ⚠ 切回每拍后和台词对不上:${misaligned.join("/")}`);

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
  meta.misaligned = misaligned;
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
  const { url } = await uploadP(item, preview, `${fileBase}-${stamp()}.mp3`, "上传配音");
  const wave = join(dir, `${fileBase}-wave.png`);
  await ffmpeg(["-i", preview, "-filter_complex", "showwavespic=s=1800x140:colors=#e8622c", "-frames:v", "1", wave]);
  const { url: waveUrl } = await upload(item.projectId, wave, `${fileBase}-wave-${stamp()}.png`);
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
  const { clips: staged, info } = await withDelivery(item, clips);

  // 出两版让她挑。配音是这条片里最难用规则定死的一步,给两个方向让她听完点一个。
  mark(item, null, "合成 A 版(稳一点)");
  const takeA = await renderTake(item, staged, dir, "", "voice-preview", TAKE_BASE_SAY);
  mark(item, null, "合成 B 版(冲一点)");
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
  const chars = staged.reduce((n, c) => n + [...String(c.text || "")].length, 0);
  const decisions = [
    { topic: "音色", choice: profile.voice_id, why: `项目设置里选的音色(${TTS_MODEL})` },
    { topic: "合成方式", choice: `整条稿一次合成(${chars} 字)`, why: "分拍单独合成时每次调用音色都会漂(实测最大跳 4 个半音),MiniMax 没有跨调用保持音色的办法" },
    {
      topic: "念法",
      choice: `A ${sayA.speed.toFixed(2)}x ${sayA.emotion ?? "auto"} · B ${sayB.speed.toFixed(2)}x ${sayB.emotion ?? "auto"}`,
      why: "一次合成只能用一套语速/音高/情绪:脚本里每拍标的这三项这次不生效,起伏靠句中停顿和句尾留白",
    },
    { topic: "总长", choice: `A ${takeA.total.toFixed(1)}s · B ${takeB.total.toFixed(1)}s`, why: `目标 ~${item.duration}s`, warn: dev > 0.3 },
  ];
  if (item.reviewNote) decisions.unshift({ topic: "批注", choice: "按你的批注重标了停顿和留白", why: item.reviewNote.slice(0, 80) });
  if (info.repairs?.length) decisions.push(...info.repairs);
  const mis = [...new Set([...(takeA.meta.misaligned || []), ...(takeB.meta.misaligned || [])])];
  decisions.push(
    mis.length
      ? { topic: "切分", choice: `${mis.join("/")} 切回每拍后和台词对不上`, why: "整段音频切成每拍时切口不在句子边界上,剪辑和字幕会错位 —— 打回重出配音", warn: true }
      : { topic: "切分", choice: "每拍都和台词逐字对上", why: "整段一次合成再按字切回每拍(只数字,不数标点)" },
  );
  if (info.failed) decisions.push({ topic: "念法", choice: "AI 补标念法失败", why: `缺念法的 ${info.missing.join("/")} 用了默认停顿和留白`, warn: true });
  for (const m of meta) {
    const pauses = (String(m.tts || "").match(/<#[\d.]+#>/g) || []).length;
    decisions.push({ beat: m.name, topic: "时长", choice: `${m.dur.toFixed(1)}s + 句尾留白 ${Number(m.gap).toFixed(2)}s${pauses ? ` · 句中停顿 ${pauses} 处` : ""}` });
    if (info.defaulted.includes(m.name)) decisions.push({ beat: m.name, topic: "念法", choice: "用了默认留白", why: "脚本没标这拍的念法,AI 补标时也漏了它" });
    if (info.dropped.includes(m.name)) decisions.push({ beat: m.name, topic: "停顿", choice: "没用 AI 标的停顿版", why: "AI 标停顿时改了字,按原台词念", warn: true });
    if (!m.words?.length) decisions.push({ beat: m.name, topic: "切分", choice: "这拍没分到字", why: "整段音频按字切回每拍时没对上,剪辑和字幕会错位,建议打回重出", warn: true });
    else if (m.dur > 20) decisions.push({ beat: m.name, topic: "切分", choice: `这拍 ${m.dur.toFixed(1)}s,偏长`, why: "切点可能不准", warn: true });
  }
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
    decisions,
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
  const scriptClips = up.script?.clips || [];

  // 拍数对不上时直接说清是哪几拍多了/少了,而不是渲到一半 ffmpeg 报错
  const vNames = cardsMeta.map((c) => c.name);
  const aNames = (meta || []).map((m) => m.name);
  if (vNames.length !== aNames.length) {
    const onlyV = vNames.filter((n) => !aNames.includes(n));
    const onlyA = aNames.filter((n) => !vNames.includes(n));
    throw new Error(
      `画面 ${vNames.length} 拍、配音 ${aNames.length} 拍,对不上` +
      `${onlyV.length ? `(只有画面:${onlyV.join("/")})` : ""}${onlyA.length ? `(只有配音:${onlyA.join("/")})` : ""}` +
      "。通常是改了拍数,但素材或配音没跟着重出 —— 把拍数不对的那一步重做一下",
    );
  }

  // per-clip visual source: 真素材(录屏/图片) > 字卡
  const visuals = [];
  for (let i = 0; i < cardsMeta.length; i++) {
    const cm = cardsMeta[i];
    mark(item, cm.name, "下载画面");
    const sc = scriptClips.find((c) => c.name === cm.name);
    const overrides = sc?.overrides || {};
    const inserts = Array.isArray(sc?.inserts) ? sc.inserts : [];
    if (cm.shots) {
      // 她在网页上改过的镜头(脚本阶段 clips[i].shots)优先,不用等素材阶段重跑
      const shots = normalizeShots(sc?.shots?.length ? sc.shots : cm.shots);
      const assetPaths = {};
      for (const s of shots) {
        if (!s.asset || assetPaths[s.asset]) continue;
        const asset = assets.find((a) => a.name === s.asset);
        if (!asset) throw new Error(`${cm.name} 的镜头用了素材「${s.asset}」,素材库里没有了(可能被删了)`);
        assetPaths[s.asset] = { path: await downloadCached(asset.url, join(assetsDir, s.asset)), kind: asset.kind };
      }
      const theme = up.script?.editSettings?.theme || cm.theme || "ink";
      const imageStyle = up.script?.editSettings?.imageStyle || "photo";
      visuals.push({ kind: "shots", source: "shots", shots, theme, imageStyle, cast: up.footage?.cast?.main || null, assetPaths, by: sc?.shots?.length ? "you" : "auto", overrides, inserts });
    } else if (cm.anim) {
      const p = await downloadCached(cm.anim, join(cardsDir, `${cm.name}.webm`));
      visuals.push({ kind: "anim", source: "anim", path: p, overrides, inserts });
    } else if (cm.asset) {
      const asset = assets.find((a) => a.name === cm.asset);
      if (!asset) throw new Error(`素材「${cm.asset}」不在素材库里(可能被删了)`);
      const p = await downloadCached(asset.url, join(assetsDir, cm.asset));
      visuals.push({ kind: asset.kind, source: asset.kind === "video" ? "asset-video" : "asset-image", asset: cm.asset, path: p, overrides, inserts });
    } else {
      const p = images[i] ? await downloadCached(images[i], join(cardsDir, `${cm.name}.png`)) : join(cardsDir, `${cm.name}.png`);
      visuals.push({ kind: "image", source: "card", type: cm.type, path: p, overrides, inserts });
    }
  }
  // voiceMeta.tag 标出这一版用的文件后缀(A 版 "",B 版 "-b")—— 整段一次合成之后,
  // 每拍的音频已经从同一次生成里切好了,只需要按 tag 找到对应文件,不用重新调 TTS。
  // 只有文件真的不在(工作目录被清过这种极端情况)才退回单独合成一拍兜底,
  // 兜底出来的这一拍音色会和其它拍略有差异(独立调用没有连续性保证),但好过整段崩掉。
  const tag = up.voice?.voiceMeta?.tag ?? "";
  const voices = [];
  const patched = [];
  for (const m of meta || []) {
    const p = join(voiceDir, `${m.name}${tag}.mp3`);
    if (!existsSync(p)) {
      mark(item, m.name, "补合成丢失的配音");
      console.log(`  [edit] ${m.name}${tag} 的配音文件丢了,单独补一拍兜底(音色可能和其它拍有细微差异)`);
      await voiceClip(item, { ...m, say: sayToInput(m.say) }, voiceDir, tag);
      patched.push(m.name);
    }
    voices.push(p);
  }
  return { visuals, voices, meta, patched };
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
// 动画卡专用的三种:卡是满幅设计的,z 超过 1.08 就开始啃到四边的文字,
// 所以只给很轻的推/拉,不给横摇。轮流用,相邻两拍不重样。
const CAM_ANIM = {
  pushSoft: (n) => ({ z: `1+0.055*on/${n}`, x: CAM_X, y: CAM_Y }),
  pullSoft: (n) => ({ z: `1.055-0.055*on/${n}`, x: CAM_X, y: CAM_Y }),
  pushMicro: (n) => ({ z: `1+0.03*on/${n}`, x: CAM_X, y: CAM_Y }),
};
const CAM_ANIM_ORDER = ["pushSoft", "pullSoft", "pushMicro"];
// 每个节拍的候选,按优先级;取第一个和上一拍不同的
const CAM_BY_BEAT = {
  hook: ["pushIn", "panRight"],
  context: ["panRight", "driftUp", "pushSoft"],
  evidence: ["driftUp", "pushSoft", "panLeft"],
  turn: ["pullOut", "hold"],
  landing: ["hold", "pushSoft"],
};
const CAM_FALLBACK = ["pushSoft", "panRight", "driftUp", "pullOut", "hold", "panLeft"];

// 固定运镜 → Remotion Cam 的关键帧(cx/cy 0-1)。几乎不动的 hold 直接给静止:她说过「静止就可以了」
function moveKeys(move, frames) {
  const F = Math.max(1, frames - 1);
  const K = (z0, z1, x0 = 0.5, x1 = 0.5, y0 = 0.5, y1 = 0.5) => [{ f: 0, z: z0, cx: x0, cy: y0 }, { f: F, z: z1, cx: x1, cy: y1 }];
  switch (move) {
    case "pushIn": return K(1, 1.11);
    case "pushSoft": return K(1, 1.06);
    case "pullOut": return K(1.11, 1.01);
    case "panRight": return K(1.07, 1.07, 0.468, 0.532);
    case "panLeft": return K(1.07, 1.07, 0.532, 0.468);
    case "driftUp": return K(1.08, 1.08, 0.5, 0.5, 0.537, 0.463);
    case "pullSoft": return K(1.055, 1);
    case "pushMicro": return K(1, 1.03);
    default: return [];
  }
}

function pickCamera(beat, index, prev) {
  const candidates = CAM_BY_BEAT[beat] || [CAM_FALLBACK[index % CAM_FALLBACK.length], ...CAM_FALLBACK];
  return candidates.find((c) => c !== prev) || candidates[0];
}

// ── 转场:硬切是"幻灯片感"的主要来源 ──────────────────────────────
// 但也不能每刀都花哨 —— 一条 6-12 拍的片子只配 1-2 个重转场,其余用短交叉淡化,
// 否则转场本身变成噪音。重转场留给叙事真正拐弯的地方(turn / landing)。
// 2026-09-24 起照 ops-bilibili:一律硬切(她认可的片子几乎全是硬切;叠化会让两层字叠在一起,
// 滑动类重转场也不再默认给)。0.067s = 2 帧的 xfade,看起来就是硬切;短于 1.5 帧 xfade 会静默丢画面
function planTransitions(meta) {
  return meta.slice(1).map((m) => ({ type: "fade", dur: 0.067, into: m.name, why: "硬切:她认可的片子几乎全是硬切,叠化会让前后两层字叠在一起" }));
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

// 返回一段可以直接接在 -vf 里的滤镜(含标签分支),外加这次用了哪种进画方式、为什么。
// force = 她的参数覆盖(contain / cover),不给就按宽高比自动选。
function fitChain(W, H, srcW, srcH, force) {
  const tAR = W / H;
  const sAR = srcW && srcH ? srcW / srcH : tAR;
  const diff = Math.abs(sAR - tAR) / tAR;
  // 铺满要裁掉多少:素材更宽 → 裁左右;素材更高 → 裁上下
  const cut = sAR > tAR ? 1 - tAR / sAR : 1 - sAR / tAR;
  const side = sAR > tAR ? "左右" : "上下";
  const dims = `素材 ${srcW || "?"}×${srcH || "?"}(${arLabel(srcW, srcH)})→ 画面 ${W}×${H}(${arLabel(W, H)})`;
  const fit = force === "cover" || force === "contain" ? force : diff <= FIT_TOLERANCE ? "cover" : "contain";
  let why;
  if (diff < 0.005) why = `${dims},比例一致,直接铺满`;
  else if (fit === "cover") why = `${dims},铺满会裁掉${side}各 ${pct(cut / 2)}${force ? "" : `;比例只差 ${pct(diff)},裁的是边角`}`;
  else why = `${dims},比例差 ${pct(diff)},铺满会裁掉${side}各 ${pct(cut / 2)};所以整幅放进去,空出来的地方垫它自己的模糊放大版`;
  if (fit === "cover") {
    return {
      chain: `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
      mode: "铺满裁切",
      fit,
      why,
      warn: cut > 0.1,
    };
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
    fit,
    why,
    warn: false,
  };
}

// 把一段素材视频(或动画卡 webm)渲成正好 segDur 长的一拍,返回这一拍的决定清单。
// setsar=1 是关键:素材如果带着非方形像素的 SAR/DAR 元数据(实见她的一个上传素材),
// scale+crop 完全不会清掉这个标签,原样传到成片,变成"编码 1080x1920、播放器按
// 5040x1920 显示"——横向被拉成宽屏。
// ov = 她挂在这一拍上的参数覆盖:fit / slow / fill / from / camera。
export async function renderAssetSeg(src, out, { W, H, fps, segDur, move = null, frames = 0, still = false, ov = {}, beat, camKeys = null } = {}) {
  const info = await ffprobeInfo(src);
  const vs = (info.streams || []).find((s) => s.codec_type === "video") || {};
  const rawDur = parseFloat(info.format?.duration) || 0;
  const you = (k) => ov[k] != null;
  const decisions = [];

  // 起点:她说"从第 2 秒开始"—— 先切出一段,后面放慢/接龙/循环都在切好的这段上做
  let input = src;
  const from = !still && ov.from ? Math.min(Number(ov.from), Math.max(0, rawDur - 0.5)) : 0;
  if (from > 0) {
    input = out.replace(/\.mp4$/, "-from.mp4");
    await ffmpeg(["-ss", from.toFixed(3), "-i", src, "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", input]);
  }
  const srcDur = Math.max(0, rawDur - from);

  const fitInfo = fitChain(W, H, vs.width, vs.height, still ? undefined : ov.fit);
  if (!still) {
    decisions.push({ beat, topic: "进画", choice: fitInfo.mode, why: fitInfo.why, key: "fit", value: fitInfo.fit, by: you("fit") ? "you" : "auto", warn: fitInfo.warn });
  }

  let speed = 1;
  let hold = 0;
  let loop = false;
  if (still) {
    // 动画卡:入场演完就该是静止的,拉慢等于把设计好的节奏改掉,倒放更是把入场
    // 反着播一遍。短了就冻最后一帧——反正那一帧和它之后本来就一模一样。
    if (srcDur > 0.1 && srcDur < segDur - 0.05) {
      hold = segDur - srcDur;
      decisions.push({ beat, topic: "时长", choice: `动画 ${s1(srcDur)} 演完,停在最后一帧 ${s1(hold)}`, why: "入场演完本来就是静止的,拉慢会改掉设计好的节奏" });
    }
  } else {
    const short = srcDur > 0.1 && srcDur < segDur - 0.05;
    speed = you("slow") ? Number(ov.slow) : short ? Math.min(MAX_SLOWDOWN, segDur / srcDur) : 1;
    decisions.push({
      beat,
      topic: "速度",
      choice: speedLabel(speed),
      why: `素材 ${s1(srcDur)}${from ? `(从第 ${s1(from)} 起)` : ""},这一拍 ${s1(segDur)}` +
        (you("slow") ? "" : short ? `;自动放慢最多 ${MAX_SLOWDOWN} 倍,再慢就不像正常操作了` : ";素材够长,不用放慢"),
      key: "slow",
      value: Number(speed.toFixed(2)),
      by: you("slow") ? "you" : "auto",
    });
    const played = srcDur * speed;
    if (played < segDur - 0.05) {
      const want = ov.fill ?? "pingpong";
      const gap = segDur - played;
      let fill = want;
      let choice;
      let why;
      let warn = false;
      if (want === "pingpong" && srcDur > MAX_REVERSIBLE) fill = "freeze";
      if (fill === "pingpong") {
        // 正放 + 倒放接成一段:接缝两端是同一帧,循环起来没有跳切。
        // trim=start_frame=1 去掉倒放重复的那一帧。
        const pp = out.replace(/\.mp4$/, "-pp.mp4");
        await ffmpeg([
          "-i", input, "-filter_complex",
          "[0:v]split=2[f][r];[r]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[f][rv]concat=n=2:v=1:a=0[v]",
          "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", pp,
        ]);
        input = pp;
        loop = true;
        const rounds = segDur / (2 * played);
        choice = rounds <= 1 ? `正放一遍,再倒放 ${s1(gap)}` : `正倒放接龙 ${rounds.toFixed(1)} 轮`;
        why = `放完 ${s1(played)},还差 ${s1(gap)};正放接倒放,接缝两端是同一帧,看不出跳切`;
        // 来回放超过一轮,同一段内容就重复出现了 —— 和"硬循环 2.7 圈"是同一种毛病,只是没有跳切
        if (rounds > 1.2) {
          why += `;但同一段 ${s1(srcDur)} 的内容来回出现了 ${rounds.toFixed(1)} 轮,看得出重复 —— 换一段更长的素材,或者把这拍拆短`;
          warn = true;
        }
      } else if (fill === "loop") {
        loop = true;
        choice = `硬循环 ${(segDur / played).toFixed(1)} 遍`;
        why = `放完 ${s1(played)},还差 ${s1(gap)};每遍结尾会跳回开头`;
        warn = true;
      } else {
        hold = gap;
        choice = `冻最后一帧 ${s1(hold)}`;
        why = want === "pingpong" ? `素材超过 ${MAX_REVERSIBLE}s,倒放要把整段读进内存,改成冻帧` : `放完 ${s1(played)},还差 ${s1(gap)}`;
        warn = hold > 2;
      }
      decisions.push({ beat, topic: "不够长时", choice, why, key: "fill", value: fill, by: you("fill") ? "you" : "auto", warn });
    } else if (played > segDur + 0.5) {
      const used = segDur / speed;
      const unused = srcDur - used;
      decisions.push({
        beat,
        topic: "起点",
        choice: `只用 ${s1(from)}–${s1(from + used)}`,
        why: `素材放完要 ${s1(played)},这一拍只有 ${s1(segDur)};后面 ${s1(unused)} 没用上${unused > 3 ? ",想用后面的内容就改起点" : ""}`,
        key: "from",
        value: from,
        by: you("from") ? "you" : "auto",
        warn: unused > 3 && !you("from"),
      });
    } else if (from) {
      decisions.push({ beat, topic: "起点", choice: `从第 ${s1(from)} 开始`, key: "from", value: from, by: "you" });
    }
  }

  // 运镜:动画卡入场完是真静止的(shotcraft 的判例,元素落定后不许再动),
  // 一拍十几秒全靠镜头给活气。录屏默认不加(本来就在动),她可以要。
  // 运镜:ffmpeg 只管时长和进画,镜头交给 Remotion(亚像素,不抖)。对焦计划优先于固定运镜
  const keys = camKeys?.length ? camKeys : move && move !== "none" && frames > 0 ? moveKeys(move, frames) : [];

  const vf = [
    ...(Math.abs(speed - 1) > 0.02 ? [`setpts=${speed.toFixed(4)}*PTS`] : []),
    ...(hold > 0.05 ? [`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`] : []),
    fitInfo.chain, `fps=${fps}`, "format=yuv420p",
  ].join(",");

  const fitted = keys.length ? out.replace(/\.mp4$/, "-fit.mp4") : out;
  await ffmpeg([
    ...(loop ? ["-stream_loop", "-1"] : []), "-i", input, "-t", segDur.toFixed(3),
    "-vf", vf, "-an", "-c:v", "libx264", "-crf", keys.length ? "16" : "19", "-preset", "medium", "-pix_fmt", "yuv420p", fitted,
  ]);
  if (keys.length) {
    await renderCam({ srcPath: fitted, kind: "video", keys, W, H, frames: Math.max(1, Math.round(segDur * fps)) }, out, { workRoot: WORK_ROOT });
    rmSync(fitted, { force: true });
  }
  return { decisions };
}

const totalDurOf = (tl) => (tl.length ? tl[tl.length - 1].start + tl[tl.length - 1].dur + tl[tl.length - 1].gap : 0);

// 插入点记成"念到哪个字"(anchor = 那个字在这拍台词里的位置 + 从那儿起的几个字):
// 配音重做、语速变了,插入跟着那个字走;字对不上了就退回当初的秒数
function anchorTime(words, anchor, offset, beatDur) {
  const index = spokenIndex(words || []);
  if (anchor?.text) {
    const at = index.text.indexOf(anchor.text, Math.max(0, (anchor.charIdx ?? 0) - 6));
    const exact = [...index.text].slice(anchor.charIdx ?? 0, (anchor.charIdx ?? 0) + [...anchor.text].length).join("") === anchor.text;
    const ci = exact ? anchor.charIdx : at >= 0 ? [...index.text.slice(0, at)].length : -1;
    if (ci >= 0 && index.times[ci] != null) return { t: index.times[ci], how: `从念到「${anchor.text}」开始(跟着字走,配音变了位置也跟着变)` };
  }
  const t = Math.max(0, Math.min(beatDur - 0.5, Number(offset) || 0));
  return { t, how: anchor?.text ? `台词里找不到「${anchor.text}」了,按当初的位置(这拍第 ${s1(t)})放` : `这拍第 ${s1(t)} 开始` };
}

// 插入的素材先单独渲成一小段:全屏按进画规则放进画面;画中画缩到 62% 宽、加白边
async function prepInsert(ins, asset, src, { W, H, fps, dir }) {
  const dur = Math.max(0.3, ins.dur);
  const out = join(dir, `insert-${String(ins.id).replace(/[^\w-]/g, "")}.mp4`);
  const info = await ffprobeInfo(src);
  const vs = (info.streams || []).find((x) => x.codec_type === "video") || {};
  const srcDur = parseFloat(info.format?.duration) || 0;
  const from = asset.kind === "video" ? Math.max(0, Math.min(Number(ins.from) || 0, Math.max(0, srcDur - 0.5))) : 0;
  const pip = ins.mode === "pip" && ins.kind !== "gap";
  let vf;
  if (pip) {
    const bw = evenPx(W * 0.62), bh = evenPx(H * 0.5);
    vf = `scale=${bw}:${bh}:force_original_aspect_ratio=decrease,pad=iw+12:ih+12:6:6:white,setsar=1`;
  } else {
    vf = fitChain(W, H, vs.width, vs.height).chain;
  }
  const hold = asset.kind === "video" && srcDur - from < dur ? dur - (srcDur - from) : 0;
  const r = await cached(out, { kind: "insert", src: await fileSha(src), vf, dur: Math.round(dur * 1000), from, fps }, async (tmp) => {
    const inArgs = asset.kind === "video" ? ["-ss", from.toFixed(3), "-i", src] : ["-loop", "1", "-framerate", String(fps), "-i", src];
    const chain = [...(hold > 0.05 ? [`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`] : []), vf, `fps=${fps}`, "format=yuv420p"].join(",");
    await ffmpeg([...inArgs, "-t", dur.toFixed(3), "-vf", chain, "-an", "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p", tmp]);
  });
  return out;
}

// 一拍动态镜头 → seg-<拍>.mp4。连续的模板镜头合成一次 Remotion 渲染,素材镜头按进画规则单独渲,
// 最后按顺序接起来。每一段按内容缓存:只改了一个镜头的字,只重渲它所在的那一段。
async function renderShotsBeat(item, v, { beat, words, beatDur, segDur, W, H, fps, dir, ov }) {
  const decisions = [];
  const seg = join(dir, `seg-${beat}.mp4`);
  const index = shotIndex(words);
  const { spans, notes } = timeShots(v.shots, index, beatDur, segDur, fps);
  const runs = [];
  for (const sp of spans) {
    const s = v.shots[sp.i];
    const last = runs[runs.length - 1];
    if (s.tpl && last?.kind === "tpl") last.spans.push(sp);
    else runs.push({ kind: s.tpl ? "tpl" : "asset", spans: [sp] });
  }
  const parts = [];
  let reusedParts = 0;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const f0 = run.spans[0].fromFrame;
    const nFrames = run.spans.reduce((n, sp) => n + sp.frames, 0);
    const part = join(dir, `seg-${beat}-p${r}.mp4`);
    if (run.kind === "tpl") {
      // 画面镜头:本地有缓存直接用;素材阶段传过的就下载;都没有(她在网页上新加的)就现在生成
      const withImg = [];
      for (const sp of run.spans) {
        const s0 = v.shots[sp.i];
        if (s0.tpl !== "scene" || !s0.p?.prompt) {
          withImg.push(s0.p);
          continue;
        }
        const withMain = s0.p.who === "main" && v.cast?.key;
        const key = sceneKey(s0.p.prompt, v.imageStyle, item.aspect, withMain ? v.cast.key : "");
        const imgDir = join(workDir(item, ""), ".images");
        let path = null;
        try {
          const cache = join(imgDir, `${key}.jpg`);
          if (existsSync(cache)) path = cache;
          else if (s0.p.src && s0.p.srcKey === key) path = await downloadCached(s0.p.src, join(imgDir, `${key}-dl.jpg`));
          else if (!SCENE_ON) {
            // 配图没开:有旧图就用旧图,没有就纯色底,绝不去生成
            if (s0.p.src) path = await downloadCached(s0.p.src, join(imgDir, `${s0.p.srcKey || key}-dl.jpg`));
            else decisions.push({ beat, topic: "画面", choice: "这个画面镜头没有图,先用纯色底", why: "配图没开(要你同意用哪家之后才打开)", warn: true });
          } else {
            // 她在网页上新加/改过的画面:现在生成;有主角的带上定妆照(本地没有就从素材阶段传的那张下载)
            mark(item, beat, "生成画面");
            let ref = null;
            if (withMain) {
              const local = join(imgDir, `${v.cast.key}.jpg`);
              ref = { key: v.cast.key, path: existsSync(local) ? local : await downloadCached(v.cast.src, join(imgDir, `${v.cast.key}-dl.jpg`)) };
            }
            path = (await sceneImage(s0.p.prompt, { style: v.imageStyle, aspect: item.aspect, workRoot: workDir(item, ""), ref })).path;
          }
        } catch (e) {
          decisions.push({ beat, topic: "画面", choice: "这张图没生成出来,先用纯色底", why: String(e.message).slice(0, 140), warn: true });
        }
        withImg.push(path ? { ...s0.p, src: dataUrl(path) } : { ...s0.p, src: undefined });
      }
      const props = {
        theme: v.theme,
        W,
        H,
        frames: nFrames,
        shots: run.spans.map((sp, j) => ({ tpl: v.shots[sp.i].tpl, p: withImg[j], from: sp.fromFrame - f0, frames: sp.frames, cues: sp.cues })),
      };
      mark(item, beat, `渲镜头动画(${run.spans.length} 个)`);
      const res = await cached(part, { kind: "shots", props, tv: shotsVersion() }, async (tmp) => {
        await renderBeat(props, tmp, { workRoot: WORK_ROOT });
      });
      if (res.reused) reusedParts++;
    } else {
      const s = v.shots[run.spans[0].i];
      const a = v.assetPaths[s.asset];
      const dur = nFrames / fps;
      const still = a.kind !== "video";
      mark(item, beat, "素材镜头进画");
      const res = await cached(part, { kind: "asset", src: await fileSha(a.path), W, H, fps, segDur: Math.round(dur * 1000), frames: nFrames, still, ov: still ? {} : ov }, async (tmp) => {
        const out = await renderAssetSeg(a.path, tmp, { W, H, fps, segDur: dur, move: null, frames: nFrames, still, ov: still ? {} : ov, beat });
        return { decisions: out.decisions };
      });
      decisions.push(...(res.meta?.decisions || []));
      if (res.reused) reusedParts++;
    }
    parts.push(part);
  }
  // 接起来,同时统一成和其它拍一样的格式:Remotion 出的是全色域 yuvj420p、时间基 1/90000,
  // 不统一的话后面 xfade 拼接直接报 Invalid argument
  mark(item, beat, "接镜头");
  {
    const inputs = parts.flatMap((p) => ["-i", p]);
    const norm = (k) => `[${k}:v]scale=in_range=auto:out_range=tv,format=yuv420p,setsar=1,fps=${fps}[v${k}]`;
    const chain = parts.map((_, k) => norm(k)).join(";") + ";" + parts.map((_, k) => `[v${k}]`).join("") + `concat=n=${parts.length}:v=1:a=0[v]`;
    await ffmpeg([...inputs, "-filter_complex", chain, "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p", "-video_track_timescale", "15360", seg]);
  }
  const line = spans
    .map((sp) => {
      const s = v.shots[sp.i];
      const name = s.asset ? `录屏「${String(s.asset).slice(0, 10)}」` : TPL_LABEL[s.tpl] ?? s.tpl;
      return `${name} ${sp.start.toFixed(1)}–${Math.min(beatDur, sp.end).toFixed(1)}s`;
    })
    .join(" → ");
  const hit = spans.slice(1).filter((sp) => sp.cut === "spoken").length;
  decisions.push({
    beat,
    topic: "镜头",
    choice: line,
    why: `${v.by === "you" ? "你改过的镜头;" : ""}切点跟着配音走(念到那几个字就切),${hit}/${Math.max(0, spans.length - 1)} 个切点对上了台词${notes.length ? `;${notes.join(";")}` : ""}${reusedParts === parts.length ? ";和上次一样,直接沿用" : reusedParts ? `;${reusedParts}/${parts.length} 段沿用` : ""}`,
    warn: notes.length > 0,
    by: v.by === "you" ? "you" : "auto",
  });
  // 音效/死帧质检要知道"画面在哪些时刻有变化":镜头切点 + 镜头里元素出现的时刻
  const reveals = spans.flatMap((sp) => [sp.start, ...sp.cues.filter((c) => c != null).map((c) => sp.start + c / fps)]).filter((t) => t > 0.5 && t < beatDur - 0.3);
  const assetSec = spans.filter((sp) => v.shots[sp.i].asset).reduce((n, sp) => n + Math.max(0, Math.min(beatDur, sp.end) - sp.start), 0);
  return { decisions, reused: reusedParts === parts.length, reveals, assetSec };
}

/** 脚本里这拍的节拍类型(hook/context/evidence/turn/landing),配音元数据里没有就从脚本查 */
function scriptKind(item, name) {
  return (item.upstream?.script?.clips || []).find((c) => c.name === name)?.beat || null;
}

async function edit(item) {
  const up = item.upstream || {};
  mark(item, null, "下载画面和配音");
  const { visuals, voices, meta, patched } = await ensureInputs(item);
  if (!visuals.length || visuals.length !== voices.length) throw new Error("画面和配音数量对不上");
  const { width: W, height: H } = sizeFor(item.aspect);
  const dir = workDir(item, "edit");
  const fps = 30;
  const decisions = [];

  // 1) 逐拍渲染。每拍:先定画面(手绘 / 按念到的时间分步出现 / 原来的卡或素材)→ 再定镜头
  //    (录屏按台词对焦 / 固定运镜)→ 最后按内容缓存(segcache):素材、时长、参数都没变的拍直接复用。
  const segs = [];
  let lastMove = null;
  const cameraLog = [];
  const cardsMeta = up.footage?.cards || [];
  const settings = up.script?.editSettings || {};
  const sfxBeats = [];
  const focusCues = [];
  let drawnAuto = 0;
  let reused = 0;
  let productSec = 0; // 真产品画面(素材库里的录屏/截图)一共多少秒 —— ops-bilibili 的规矩是至少一半
  let cumStart = 0;
  // 第 i 段要多渲一个转场的时长,给下一刀当重叠料;xfade 吃掉的正好是多出来的部分,
  // 所以成片总长仍然等于 Σ(每拍时长 + 句尾留白),音轨不用动。
  const trans = planTransitions(meta);
  // 两拍都是动态镜头:普通衔接用硬切。镜头自己有入场动画,叠化只会让前后两层字叠在一起像花屏
  // (2026-09-23 看成片:女命/官杀 和 你的正缘画像 叠在同一个位置)。重转场(推/滑)保留。
  trans.forEach((t, k) => {
    if (t.type === "fade" && visuals[k]?.source === "shots" && visuals[k + 1]?.source === "shots") {
      // 0.067s = 2 帧,看起来就是硬切;xfade 的时长短于 ~1.5 帧会静默失败,后面的拍全被丢掉
      Object.assign(t, { type: "fade", dur: 0.067, why: "镜头之间硬切:每个镜头自己有入场动画,叠化会让两层字叠在一起" });
    }
  });
  // 每拍句尾的停顿 = 你拖出来的停顿(覆盖)或配音自带的 + 插在这段停顿里的纯画面时长。
  // 纯画面插入不动配音、不动素材 —— 只是把这里的停顿拉长 N 秒,这 N 秒里全屏放素材。
  const effGap = meta.map((m, i) => {
    const ov = visuals[i]?.overrides || {};
    let base = ov.gap != null ? Number(ov.gap) : m.gap ?? GAP;
    // 片尾:最后一个字念完留 1.3 秒,最后 0.7 秒淡出(ops-bilibili 的收尾规矩;她拖过停顿就听她的)
    if (i === meta.length - 1 && ov.gap == null) base = Math.max(base, TAIL_HOLD);
    const extra = (visuals[i]?.inserts || []).filter((x) => x.kind === "gap").reduce((n, x) => n + Number(x.dur || 0), 0);
    return { base, extra, total: base + extra, you: ov.gap != null };
  });
  for (let i = 0; i < visuals.length; i++) {
    const v = visuals[i];
    const beat = meta[i].name;
    const ov = v.overrides || {};
    const beatDur = meta[i].dur + effGap[i].total;
    if (effGap[i].you) {
      decisions.push({ beat, topic: "停顿", choice: `句尾停 ${effGap[i].base.toFixed(2)}s`, why: `配音自带 ${(meta[i].gap ?? GAP).toFixed(2)}s,你在时间轴上拖过`, key: "gap", value: Number(effGap[i].base.toFixed(2)), by: "you" });
    }
    const segDur = beatDur + (trans[i] ? trans[i].dur : 0);
    const frames = Math.ceil(segDur * fps);
    const words = meta[i].words || [];
    const seg = join(dir, `seg-${beat}.mp4`);
    const beatInfo = { name: beat, kind: meta[i].beat || scriptKind(item, beat), start: cumStart, dur: beatDur, words, transitionIn: i > 0 ? trans[i - 1] : null, reveals: [], drawn: false };
    ensureDisk(dir, 0.5, `渲 ${beat} `);
    if (v.source === "shots") {
      const r = await renderShotsBeat(item, v, { beat, words, beatDur, segDur, W, H, fps, dir, ov });
      decisions.push(...r.decisions);
      if (r.reused) reused++;
      productSec += r.assetSec || 0;
      beatInfo.reveals = r.reveals;
      console.log(`  [edit] seg ${beat} ${segDur.toFixed(1)}s done (${v.shots.length} 个镜头${r.reused ? ",沿用" : ""})`);
      segs.push(seg);
      sfxBeats.push(beatInfo);
      cumStart += beatDur;
      continue;
    }
    decisions.push({
      beat,
      topic: "画面",
      choice: v.source === "anim" ? `${CARD_TYPES[v.type] ?? "设计卡"}(动画)` : v.source === "card" ? `${CARD_TYPES[v.type] ?? "设计卡"}(静态图)` : `${v.kind === "video" ? "录屏" : "图片"}「${v.asset}」`,
      why: `这拍 ${s1(segDur)}(配音 ${s1(meta[i].dur)} + 句尾停顿 ${s1(effGap[i].total)}${effGap[i].extra ? `,其中 ${s1(effGap[i].extra)} 是插进来的纯画面` : ""}${trans[i] ? ` + 给下一刀转场的重叠 ${s1(trans[i].dur)}` : ""})`,
    });

    // ── 画面源 ──
    const card = v.source === "anim" || v.source === "card" ? cardsMeta[i] : null;
    let srcPath = v.path;
    let drawn = false;
    if (card && v.source === "anim") {
      const drawable = DRAWABLE.has(card.type);
      // 手绘图解:默认只给前两个关系图/流程卡(每条片 1-2 拍,多了就不稀奇了),她可以逐拍开关
      const wantDraw = ov.draw === "on" || (ov.draw !== "off" && drawable && drawnAuto < 2 && beatDur >= 4);
      if (wantDraw && !drawReady()) {
        decisions.push({ beat, topic: "手绘", choice: "没画:本机缺手写体或 Python 环境", why: "在 worker 目录跑 worker/py/setup.sh", warn: true });
      } else if (wantDraw) {
        mark(item, beat, "手绘图解");
        try {
          const d = await drawCard({ card, size: { width: W, height: H }, words, beatDur, segDur, dir, beat });
          srcPath = d.path;
          drawn = true;
          if (ov.draw !== "on") drawnAuto++;
          decisions.push(...d.decisions.map((x) => ({ ...x, by: ov.draw ? "you" : "auto", why: ov.draw ? "你定的" : `${x.why};默认每条片前两个关系图/流程卡用手绘` })));
          beatInfo.drawn = true;
          beatInfo.reveals = d.elements.map((e) => e.start).filter((t) => t > 0.5);
        } catch (e) {
          decisions.push({ beat, topic: "手绘", choice: "没画成,用回原来的动画卡", why: String(e.message).slice(0, 160), warn: true, key: "draw", value: "off" });
        }
      } else if (drawable) {
        decisions.push({ beat, topic: "手绘", choice: "不手绘", why: ov.draw === "off" ? "你定的" : "这条片前面已经有两拍手绘了", key: "draw", value: "off", by: ov.draw ? "you" : "auto" });
      }
      if (!drawn) {
        const plan = planReveal(card, words, beatDur);
        if (plan.applied) {
          mark(item, beat, "按念到的时间分步出现");
          const timed = join(dir, `timed-${beat}.webm`);
          const content = { ...card };
          delete content.anim;
          delete content.layout;
          const r = await cached(timed, { kind: "timed", content, delays: plan.delays, W, H, dur: Math.round(segDur * 1000) }, async (tmp) => {
            await renderCardVideo(content, { width: W, height: H }, segDur + 0.3, tmp, { reveal: plan.delays });
          });
          srcPath = timed;
          beatInfo.reveals = plan.cues.map((c) => c.t).filter((t) => t != null && t > 0.5);
          const hit = plan.cues.filter((c) => c.matched).length;
          decisions.push({
            beat,
            topic: "分步出现",
            choice: plan.cues.map((c) => `${c.label.slice(0, 6)} ${c.t.toFixed(1)}s`).join(" · "),
            why: `这拍 ${s1(beatDur)},内容不再头一秒全弹完;${hit}/${plan.cues.length} 项对上了台词里念到它的时刻${hit < plan.cues.length ? ",其余夹在中间排开" : ""}${r.reused ? "(动画沿用上次渲好的)" : ""}`,
          });
        }
      }
    }

    if (v.source === "asset-video" || v.source === "asset-image") productSec += beatDur;
    // ── 镜头:录屏和图片素材跟着台词对焦(她没指定运镜的时候)──
    let camKeys = null;
    if ((v.source === "asset-video" || v.source === "asset-image") && (!ov.camera || ov.camera === "focus")) {
      mark(item, beat, "标出素材里的区域");
      try {
        const regions = await detectRegions(v.path, v.kind, dir);
        const pinfo = await ffprobeInfo(v.path);
        const st = (pinfo.streams || []).find((x) => x.codec_type === "video") || {};
        const fit = fitChain(W, H, st.width, st.height, ov.fit).fit;
        const fp = planFocus(regions, words, beatDur, { W, H, srcW: st.width, srcH: st.height, fit });
        if (fp.cues.length) {
          camKeys = focusCamKeys(fp.cues, { W, H, fps, frames });
          for (const c of fp.cues) focusCues.push({ beat, word: c.word, t: cumStart + c.t, until: cumStart + c.until });
          decisions.push({
            beat,
            topic: "对焦",
            choice: fp.cues.map((c) => `念到「${c.word}」${c.t.toFixed(1)}s → 推 ${c.zoom}x`).join(" · "),
            why: `看图模型在素材里标出 ${regions.length} 个区域,念到哪块推到哪块,字幕里这个词同时高亮;框没人核对过,所以最多只推 1.5 倍${fp.notes.length ? `。${fp.notes.join(";")}` : ""}`,
            key: "camera",
            value: "focus",
          });
        } else {
          decisions.push({ beat, topic: "对焦", choice: "不推", why: regions.length ? `素材里标出 ${regions.length} 个区域,台词没念到它们的名字${fp.notes.length ? `;${fp.notes.join(";")}` : ""}` : "看图模型没在素材里找到能对上的区域" });
        }
      } catch (e) {
        decisions.push({ beat, topic: "对焦", choice: "没做成,不推", why: String(e.message).slice(0, 160), warn: true });
      }
    }

    // ── 渲这一拍(按内容缓存)──
    let camNote = "";
    if (v.kind === "video" || v.kind === "anim") {
      // 录屏素材默认不加运镜(本来就在动,要推也是跟着台词对焦);动画卡加很轻的推拉,相邻两拍不重样
      const isAnim = v.kind === "anim";
      let move = null;
      let camWhy;
      if (ov.camera && (ov.camera === "none" || CAM_ANIM[ov.camera])) {
        move = ov.camera === "none" ? null : ov.camera;
        camWhy = "你定的";
      } else if (drawn) {
        camWhy = "手绘的这拍镜头不动,不然笔尖看着晃";
      } else if (isAnim) {
        // 按这一拍自己的序号选(相邻两拍序号不同,自然不重样)—— 以前用全局计数器轮流,
        // 前面某拍换成手绘/素材,后面每张卡的运镜都挪一位,缓存全部作废
        move = CAM_ANIM_ORDER[i % CAM_ANIM_ORDER.length];
        camWhy = "动画卡入场完是静止的,靠很轻的推拉给活气;三种轮流用,相邻两拍不重样";
      } else {
        camWhy = camKeys ? "跟着台词对焦(见上一条)" : "录屏本身在动,不加运镜";
      }
      mark(item, beat, drawn ? "手绘进画" : isAnim ? "动画卡进画" : "素材进画");
      const still = isAnim || drawn;
      const parts = { kind: "asset", src: await fileSha(srcPath), W, H, fps, segDur: Math.round(segDur * 1000), move, frames, still, ov: still ? {} : ov, cam: camKeys, camEngine: "remotion" };
      const r = await cached(seg, parts, async (tmp) => {
        const res = await renderAssetSeg(srcPath, tmp, { W, H, fps, segDur, move, frames, still, ov: still ? {} : ov, beat, camKeys });
        return { decisions: res.decisions };
      });
      if (r.reused) reused++;
      decisions.push(...(r.meta.decisions || []));
      decisions.push({ beat, topic: "运镜", choice: camKeys && !move ? "跟着台词对焦" : CAM_LABEL[move ?? "none"], why: camWhy, key: "camera", value: camKeys && !move ? "focus" : move ?? "none", by: ov.camera ? "you" : "auto" });
      camNote = move ?? (camKeys ? "focus" : "");
    } else {
      // 静态图:设计卡本来就是按画面尺寸渲的;她上传的图片比例可能不一样 —— 以前这里
      // 直接 scale 到 2W×2H,比例不同的图片会被拉变形。现在和录屏走同一套进画规则。
      let move;
      let camWhy;
      if (ov.camera && (ov.camera === "none" || CAM_MOVES[ov.camera])) {
        move = ov.camera;
        camWhy = "你定的";
      } else if (camKeys) {
        move = "focus";
        camWhy = "跟着台词对焦(见上一条)";
      } else {
        move = pickCamera(meta[i].beat, i, lastMove);
        camWhy = `按节拍「${BEAT_LABEL[meta[i].beat] ?? meta[i].beat ?? "未标"}」挑的,和上一拍不同(同一个推近重复十几遍就是最明显的 AI 感)`;
      }
      lastMove = move;
      cameraLog.push(`${beat} ${move}`);
      let pre = "";
      if (v.source === "asset-image") {
        const pinfo = await ffprobeInfo(v.path);
        const st = (pinfo.streams || []).find((x) => x.codec_type === "video") || {};
        const f = fitChain(W, H, st.width, st.height, ov.fit);
        decisions.push({ beat, topic: "进画", choice: f.mode, why: f.why, key: "fit", value: f.fit, by: ov.fit ? "you" : "auto", warn: f.warn });
        pre = `${f.chain},`;
      }
      // 静图:ffmpeg 只把图按进画规则摆成 W×H,镜头交给 Remotion(不再用 zoompan,细字不抖)
      const keys = move === "focus" ? camKeys : moveKeys(move, frames);
      const fitVf = `${pre}scale=${W}:${H}:flags=lanczos,setsar=1`;
      mark(item, beat, "静态画面加运镜");
      const r = await cached(seg, { kind: "image", src: await fileSha(v.path), fitVf, keys, segDur: Math.round(segDur * 1000), fps, camEngine: "remotion" }, async (tmp) => {
        if (!keys?.length) {
          await ffmpeg(["-loop", "1", "-framerate", String(fps), "-t", segDur.toFixed(3), "-i", v.path, "-vf", `${fitVf},fps=${fps},format=yuv420p`, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", tmp]);
          return;
        }
        const still = tmp.replace(/\.mp4$/, "-fit.png");
        await ffmpeg(["-i", v.path, "-vf", fitVf, "-frames:v", "1", still]);
        await renderCam({ srcPath: still, kind: "image", keys, W, H, frames: Math.max(1, Math.round(segDur * fps)) }, tmp, { workRoot: WORK_ROOT });
        rmSync(still, { force: true });
      });
      if (r.reused) reused++;
      decisions.push({ beat, topic: "运镜", choice: move === "focus" ? "跟着台词对焦" : CAM_LABEL[move] ?? move, why: camWhy, key: "camera", value: move, by: ov.camera ? "you" : "auto" });
      camNote = move;
    }
    if (i > 0 && trans[i - 1]) {
      const t = trans[i - 1];
      decisions.push({ beat, topic: "转场", choice: t.type === "fade" && t.dur < 0.1 ? "硬切" : t.type === "fade" ? `交叉淡化 ${t.dur}s` : `重转场 ${t.type} ${t.dur}s`, why: t.why });
    }
    console.log(`  [edit] seg ${beat} ${segDur.toFixed(1)}s ${existsSync(`${seg}.json`) ? "" : ""}done (${v.kind}${camNote ? ", " + camNote : ""})`);
    segs.push(seg);
    sfxBeats.push(beatInfo);
    cumStart += beatDur;
  }
  await closeBrowser();

  // 2) 串起来:一刀一个 xfade(offset 用"到这拍为止的累计时长",不含重叠)
  // 时间轴:每拍在成片里从哪开始、念多久、后面停多久 —— 字幕/润色/网页时间轴都按它走
  const timeline = [];
  {
    let t = 0;
    meta.forEach((m, i) => {
      timeline.push({ name: m.name, start: Number(t.toFixed(3)), dur: m.dur, gap: Number(effGap[i].total.toFixed(3)) });
      t += m.dur + effGap[i].total;
    });
  }

  // 时间轴上插入的素材:盖在原画面上(全屏 / 画中画),或者放在拉长的停顿里(纯画面)
  mark(item, null, "准备插入的素材");
  const overlays = [];
  for (let i = 0; i < visuals.length; i++) {
    let gapCursor = timeline[i].start + meta[i].dur + effGap[i].base;
    for (const ins of visuals[i].inserts || []) {
      const asset = (item.assets || []).find((a) => a.name === ins.asset);
      const beat = meta[i].name;
      if (!asset) {
        decisions.push({ beat, topic: "插入", choice: `「${ins.asset}」没插上`, why: "素材库里找不到这个文件(可能被删了)", warn: true });
        continue;
      }
      const dur = Math.max(0.5, Math.min(30, Number(ins.dur) || 3));
      let t0;
      let why;
      if (ins.kind === "gap") {
        t0 = gapCursor;
        gapCursor += dur;
        why = "放在这拍后面拉长的停顿里,纯画面、不念台词;配音和素材阶段都不用动";
      } else {
        const local = anchorTime(meta[i].words, ins.anchor, ins.offset, meta[i].dur + effGap[i].total);
        t0 = timeline[i].start + local.t;
        why = local.how;
      }
      const t1 = Math.min(totalDurOf(timeline), t0 + dur);
      const src = await downloadCached(asset.url, join(workDir(item, "assets"), asset.name));
      const clip = await prepInsert({ ...ins, dur: t1 - t0 }, asset, src, { W, H, fps, dir });
      overlays.push({ ...ins, t0, t1, clip, beat });
      decisions.push({
        beat,
        topic: "插入",
        choice: `「${ins.asset}」${ins.kind === "gap" ? "纯画面" : ins.mode === "pip" ? "画中画" : "全屏"} ${s1(t1 - t0)} · ${s1(t0)}–${s1(t1)}`,
        why,
        by: "you",
      });
    }
  }

  mark(item, null, "拼接转场");
  const videoOnly = join(dir, "video-only.mp4");
  {
    const inputs = segs.flatMap((s) => ["-i", s]);
    let offset = 0;
    const parts = trans.map((t, i) => {
      offset += meta[i].dur + effGap[i].total;
      const src = i === 0 ? "[0:v]" : `[x${i}]`;
      const dst = `[x${i + 1}]`;
      // offset = 转场开始的时刻,也就是"到这拍为止的累计时长"。
      // 每段多渲了一个转场的料,所以这一刻正好是上一段多出来那截的开头。
      return `${src}[${i + 1}:v]xfade=transition=${t.type}:duration=${t.dur}:offset=${offset.toFixed(3)}${dst}`;
    });
    let last = trans.length ? `[x${trans.length}]` : "[0:v]";
    // 插入的素材最后叠上去:淡入淡出 0.25s,只在它那段时间里显示
    overlays.forEach((o, k) => {
      const n = segs.length + k;
      inputs.push("-i", o.clip);
      const d = o.t1 - o.t0;
      const fade = Math.min(0.25, d / 4);
      parts.push(
        `[${n}:v]format=yuva420p,fade=t=in:st=0:d=${fade.toFixed(2)}:alpha=1,fade=t=out:st=${(d - fade).toFixed(3)}:d=${fade.toFixed(2)}:alpha=1,setpts=PTS-STARTPTS+${o.t0.toFixed(3)}/TB[ins${k}]`,
        `${last}[ins${k}]overlay=x='(W-w)/2':y='${o.mode === "pip" && o.kind !== "gap" ? "H*0.13" : "(H-h)/2"}':enable='between(t,${o.t0.toFixed(3)},${o.t1.toFixed(3)})':eof_action=pass[ov${k}]`,
      );
      last = `[ov${k}]`;
    });
    const totalV = meta.reduce((n, m, i) => n + m.dur + effGap[i].total, 0);
    const fadeOut = `fade=t=out:st=${Math.max(0, totalV - TAIL_FADE).toFixed(3)}:d=${TAIL_FADE}`;
    if (!parts.length) {
      await ffmpeg(["-i", segs[0], "-vf", `${fadeOut},format=yuv420p`, "-an", "-c:v", "libx264", "-crf", "19", "-preset", "fast", "-pix_fmt", "yuv420p", videoOnly]);
    } else {
      parts.push(`${last}${fadeOut}[vout]`);
      await ffmpeg([...inputs, "-filter_complex", parts.join(";"), "-map", "[vout]", "-c:v", "libx264", "-crf", "19", "-preset", "fast", "-pix_fmt", "yuv420p", videoOnly]);
    }
  }
  console.log(`  [edit] 转场:${trans.map((t) => `${t.into} ${t.type}`).join("  ")}`);

  // 3) voice track: each clip padded to its segment length, then concat
  mark(item, null, "拼配音轨");
  const inputs = voices.flatMap((v) => ["-i", v]);
  const filters = meta.map((m, i) => `[${i}:a]aresample=44100,volume=5dB,atrim=${(m.head ?? 0).toFixed(3)}:${((m.head ?? 0) + m.dur).toFixed(3)},asetpts=PTS-STARTPTS,apad=pad_dur=${effGap[i].total.toFixed(3)}[a${i}]`).join(";");
  const concatF = meta.map((_, i) => `[a${i}]`).join("") + `concat=n=${meta.length}:v=0:a=1[av]`;
  const voiceM4a = join(dir, "voice.m4a");
  await ffmpeg([...inputs, "-filter_complex", filters + ";" + concatF, "-map", "[av]", voiceM4a]);

  // 4) 音效:换拍、分步出现、手绘开笔(规则见 sfx.mjs);项目级开关在决定清单里
  const totalDur = totalDurOf(timeline);
  let sfxTrack = null;
  let sfxPlan = { events: [], dropped: [] };
  const sfxOn = settings.sfx !== "off";
  if (sfxOn && sfxReady()) {
    mark(item, null, "放音效");
    sfxPlan = planSfx(sfxBeats);
    sfxTrack = await renderSfxTrack(sfxPlan.events, totalDur, join(dir, "sfx.m4a"));
  }

  // 5) mux:人声 + 音效 + (可选)BGM 垫底
  mark(item, null, "合成画面和声音");
  const out = join(dir, "edit.mp4");
  const bgmFile = item.bgm === "yes" ? readdirSafe(join(process.cwd(), "worker", "bgm")).find((f) => f.endsWith(".mp3")) : null;
  const aIn = ["-i", voiceM4a];
  const aLabels = ["[1:a]"];
  const pre = [];
  if (sfxTrack) {
    aIn.push("-i", sfxTrack);
    aLabels.push(`[${aLabels.length + 1}:a]`);
  }
  if (bgmFile) {
    aIn.push("-stream_loop", "-1", "-i", join(process.cwd(), "worker", "bgm", bgmFile));
    const k = aLabels.length + 1;
    pre.push(`[${k}:a]aresample=44100,volume=-18dB,atrim=0:${totalDur.toFixed(3)}[bg]`);
    aLabels.push("[bg]");
  }
  // 响度统一到 -16 LUFS(克隆音原始约 -27),最后 0.7 秒和画面一起淡出
  const aFinish = `${LOUDNORM},afade=t=out:st=${Math.max(0, totalDur - TAIL_FADE).toFixed(3)}:d=${TAIL_FADE},aresample=48000`;
  if (aLabels.length === 1) {
    await ffmpeg(["-i", videoOnly, ...aIn, "-map", "0:v", "-map", "1:a", "-af", aFinish, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
  } else {
    const graph = [...pre, `${aLabels.join("")}amix=inputs=${aLabels.length}:duration=first:normalize=0,${aFinish}[a]`].join(";");
    await ffmpeg(["-i", videoOnly, ...aIn, "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
  }

  const total = await ffprobeDur(out);
  const expected = totalDur;
  const info = await ffprobeInfo(out);
  mark(item, null, "压审核用的预览");
  const preview = await makePreview(out, join(dir, "edit-preview.mp4"), item.aspect);
  const master = await keepMaster(out, dir, "edit");
  console.log("  [edit] uploading preview…");
  mark(item, null, "上传预览");
  const { url } = await uploadP(item, preview, `edit-${stamp()}.mp4`, "上传预览");
  const vs = (info.streams || []).find((x) => x.codec_type === "video") || {};
  const warn = [];
  if (Math.abs(total - expected) > 5) throw new Error(`拼出来的成片只有 ${total.toFixed(1)}s,按配音应该 ${expected.toFixed(1)}s —— 拼接转场那一步丢了画面,没有提交`);
  if (Math.abs(total - expected) > 1.5) warn.push(`成片 ${total.toFixed(1)}s 与音轨预期 ${expected.toFixed(1)}s 对不上`);
  if (Number(vs.width) !== W || Number(vs.height) !== H) warn.push(`分辨率 ${vs.width}x${vs.height} ≠ ${W}x${H}`);
  const warnLine = warn.length ? `\n⚠ 剪辑自检:${warn.join(";")}` : "";

  // 质检:产品画面占比(有产品录屏的项目至少一半)、画面里的字有没有网址
  for (const o of overlays) if (o.mode !== "pip") productSec += o.t1 - o.t0;
  const hasProduct = (item.assets || []).some((a) => a.kind === "video");
  const share = totalDur > 0 ? productSec / totalDur : 0;
  const onScreen = [
    ...meta.map((m) => m.text),
    ...visuals.flatMap((v) => (v.shots || []).map((sh) => JSON.stringify({ ...(sh.p || {}), src: undefined, prompt: undefined, srcKey: undefined }))),
  ];
  const urls = [...new Set(onScreen.flatMap((t) => String(t).match(new RegExp(URL_RE.source, "gi")) || []))];
  const audit = [
    {
      topic: "产品画面",
      choice: `${Math.round(share * 100)}%(${productSec.toFixed(1)}s / ${totalDur.toFixed(1)}s)`,
      why: hasProduct ? (share < 0.5 ? "有产品录屏的片子,真产品画面要占一半以上(ops-bilibili 的规矩)—— 多用录屏镜头,或者在时间轴上插录屏" : "达到一半以上") : "素材库里没有产品录屏,不要求",
      warn: hasProduct && share < 0.5,
    },
    ...(urls.length ? [{ topic: "网址", choice: `画面上出现了 ${urls.join("、")}`, why: "片内不许出网址(所有平台)—— 改掉这些字", warn: true }] : []),
    { topic: "收尾", choice: `最后一个字后停 ${effGap[effGap.length - 1].total.toFixed(1)}s,最后 ${TAIL_FADE}s 淡出`, why: "ops-bilibili 的收尾规矩" },
    { topic: "响度", choice: "统一到 -16 LUFS", why: "配音原始约 -27 LUFS,不统一的话在手机上听着偏小" },
  ];

  const takes = up.voice?.takes;
  const pickedLabel = takes ? takes[takes.picked ?? "a"]?.label : null;
  const ovCount = visuals.filter((v) => Object.keys(v.overrides || {}).length).length;
  const dev = Math.abs(total - item.duration) / item.duration;
  decisions.unshift(
    { topic: "用的画面", choice: `素材阶段 ${latestV(up.footage?.images) ?? "(时间不明)"} 那版`, why: `${visuals.length} 拍` },
    { topic: "用的配音", choice: `${pickedLabel ? `「${pickedLabel}」` : ""}${vtime(up.voice?.audio) ?? ""} 那版`.trim() || "配音阶段那版", why: patched.length ? `${patched.join("/")} 的音频文件丢了,单独补合成(音色可能略有差异)` : "每拍音频是从同一次整段合成里切出来的", warn: patched.length > 0 },
    { topic: "时长", choice: `${total.toFixed(1)}s`, why: `目标 ~${item.duration}s;每拍多长完全跟着配音走`, warn: dev > 0.25 },
    { topic: "背景音乐", choice: bgmFile ? `有(${bgmFile},-18dB 垫底)` : "无", why: "项目设置里选的" },
    {
      topic: "音效",
      choice: !sfxOn ? "关" : !sfxReady() ? "没加(本机缺音效文件)" : `${sfxPlan.events.length} 个` + (sfxPlan.events.length ? `(${[...new Set(sfxPlan.events.map((e) => e.label))].join("、")})` : ""),
      why: !sfxOn ? "你关掉的" : !sfxReady() ? "跑一次 node worker/sfx/fetch.mjs" : `只在章节入口放(铺垫→论据→转折→落点那一刀),全片最多 8 个,音量压低${sfxPlan.dropped.length ? `;按规则去掉了 ${sfxPlan.dropped.length} 个` : ""}`,
      key: "sfx",
      value: sfxOn ? "on" : "off",
      by: settings.sfx ? "you" : "auto",
      warn: sfxOn && !sfxReady(),
    },
    ...(visuals.some((v) => v.source === "shots")
      ? [{ topic: "配色", choice: { ink: "深墨蓝 + 香槟金", paper: "暖纸 + 朱红", dusk: "暗紫 + 暖橙" }[visuals.find((v) => v.source === "shots").theme] ?? "深墨蓝 + 香槟金", why: settings.theme ? "你定的" : "素材阶段按内容选的;点开可以换,只重做剪辑", key: "theme", value: visuals.find((v) => v.source === "shots").theme, by: settings.theme ? "you" : "auto" }]
      : []),
    ...audit,
    { topic: "渲染", choice: `重渲 ${visuals.length - reused} 拍 · 沿用 ${reused} 拍`, why: "素材、时长、参数都没变的拍直接用上次渲好的,只重渲改了的" },
    { topic: "审核用", choice: "720p 预览", why: `高清版(${(master.bytes / 1048576).toFixed(1)} MB)留在渲染机上直接给字幕用,润色时才整条上传 —— 上行慢,1080p 传一次要好几分钟` },
    ...(ovCount ? [{ topic: "你的参数", choice: `${ovCount} 拍用了你定的剪辑参数`, by: "you" }] : []),
    ...warn.map((w) => ({ topic: "自检", choice: w, warn: true })),
  );
  return {
    video: url,
    preview: true,
    master,
    decisions,
    focus: focusCues,
    timeline,
    inserts: overlays.map(({ id, asset, kind, mode, t0, t1, beat }) => ({ id, asset, kind, mode, beat, start: Number(t0.toFixed(2)), end: Number(t1.toFixed(2)) })),
    sfx: sfxPlan.events.map(({ t, kind, db, beat }) => ({ t: Number(t.toFixed(2)), kind, db, beat })),
    note: `粗剪 ${total.toFixed(1)}s,${visuals.length} 拍${bgmFile ? "(带 BGM 垫底)" : "(无 BGM)"}。${cameraLog.length ? `运镜:${cameraLog.join("  ")}` : ""}${trans.length ? `\n转场:${trans.map((t) => `${t.into} ${t.type}`).join("  ")}` : ""}
节奏/画面对位请审。${warnLine}`,
  };
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

// ── subtitles ──────────────────────────────────────────────────────────────

// 断句规矩照 ops-bilibili 的 make-subs.py:在逗号句号这类标点处断(顿号不断,列举留在一行),
// 每行最多 15 个字;超长就均分(16 个字拆成 8+8,不拆成 15+1);不到 5 个字的碎片并进上一行(并完不超过 15)。
// 行内的标点留着,只去掉行尾那个。
const SUB_MAX = 15;
const SUB_MIN = 5;
const SUB_BREAK = /[，。！？；：,.!?;:—…]/;
const SUB_PUNCT = /[\p{P}\p{S}]/u;

function subLinesOf(chars) {
  // chars: [{ch, start, end}];引号在字幕里没用,还容易剩半个,一律去掉;再按标点切段
  chars = chars.filter((c) => !/["'“”‘’「」『』]/.test(c.ch));
  const segs = [];
  let cur = [];
  for (const c of chars) {
    if (SUB_BREAK.test(c.ch)) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push(c);
  }
  if (cur.length) segs.push(cur);
  // 超长的段拆成差不多长的几行;切口不死板地放在正中间(会把「正缘」切成「正|缘」),
  // 而是在理想位置前后 4 个字里,挑两个字之间停得最久的地方(念的时候换气的地方就是词和词的边界)
  const pieces = [];
  // 太长的段先在顿号处分成短语(顿号留在前一个短语末尾),再把短语拼成 ≤15 字的行;
  // 某个短语自己就超长的,才进下面按词边界切
  const segs2 = [];
  for (const seg of segs) {
    if (seg.length <= SUB_MAX) {
      segs2.push(seg);
      continue;
    }
    const phrases = [];
    let cur = [];
    for (const c of seg) {
      cur.push(c);
      if (c.ch === "、") {
        phrases.push(cur);
        cur = [];
      }
    }
    if (cur.length) phrases.push(cur);
    let line = [];
    for (const ph of phrases) {
      if (line.length && line.length + ph.length > SUB_MAX) {
        segs2.push(line);
        line = [];
      }
      line = [...line, ...ph];
    }
    if (line.length) segs2.push(line);
  }
  for (const seg of segs2) {
    let rest = seg;
    let n = Math.ceil(rest.length / SUB_MAX);
    while (n > 1) {
      const ideal = Math.round(rest.length / n);
      let best = ideal;
      let bestGap = -1;
      for (let k = Math.max(SUB_MIN, ideal - 4); k <= Math.min(rest.length - SUB_MIN, ideal + 4); k++) {
        if (k > SUB_MAX || rest.length - k > SUB_MAX * (n - 1)) continue;
        const gap = (rest[k].start ?? 0) - (rest[k - 1].end ?? 0);
        const prev = rest[k - 1].ch;
        const next = rest[k].ch;
        // 中文词边界的土办法:顿号后面、「的了着过」后面、介词副词连词前面,这些地方几乎不会是一个词的中间
        const bonus = (prev === "、" ? 3 : 0) + (/[的了着过吗呢吧啊]/.test(prev) ? 2 : 0) + (/[把被让给跟和与在是就都也还才又但而却再从对向往用连]/.test(next) ? 2 : 0);
        const score = gap * 10 + bonus - Math.abs(k - ideal) * 0.01; // 条件一样就选离正中近的
        if (score > bestGap) {
          bestGap = score;
          best = k;
        }
      }
      pieces.push(rest.slice(0, best));
      rest = rest.slice(best);
      n = Math.ceil(rest.length / SUB_MAX);
    }
    pieces.push(rest);
  }
  // 碎片并进上一行
  const merged = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    const len = (x) => x.filter((c) => !SUB_PUNCT.test(c.ch)).length;
    if (prev && (len(p) < SUB_MIN || len(prev) < SUB_MIN) && len(prev) + len(p) <= SUB_MAX) merged[merged.length - 1] = [...prev, { ch: "\u2009", start: p[0].start, end: p[0].start }, ...p];
    else merged.push(p);
  }
  return merged
    .map((l) => {
      while (l.length && SUB_PUNCT.test(l[l.length - 1].ch)) l = l.slice(0, -1);
      while (l.length && SUB_PUNCT.test(l[0].ch) && l[0].ch !== "\u2009") l = l.slice(1);
      return l;
    })
    .filter((l) => l.length)
    .map((l) => ({ text: l.map((c) => c.ch).join(""), start: l[0].start, end: l[l.length - 1].end }));
}

// 没有字级时间戳时的兜底:只断句,时间由调用方按字数分
function splitLines(text) {
  const chars = [...String(text ?? "").replace(/——|—/g, ",")].map((ch) => ({ ch, start: 0, end: 0 }));
  const lines = subLinesOf(chars).map((l) => l.text);
  return lines.length ? lines : [text];
}

// 有字级时间戳时,行就按真实发声时间断:一行的起止取首尾字的时间,停顿天然落在两行之间
function linesFromWords(words) {
  const chars = [];
  for (const [w, b, e] of words) {
    const cs = [...String(w)];
    cs.forEach((ch, k) => {
      const t0 = b + ((e - b) * k) / cs.length;
      const t1 = b + ((e - b) * (k + 1)) / cs.length;
      chars.push({ ch, start: t0 / 1000, end: t1 / 1000 });
    });
  }
  return subLinesOf(chars).filter((l) => l.end > l.start);
}

async function subtitles(item) {
  const meta = item.upstream?.voice?.voiceMeta?.clips;
  const editVideo = item.upstream?.edit?.video;
  if (!meta?.length || !editVideo) throw new Error("缺上游配音时间轴或粗剪视频");
  const size = sizeFor(item.aspect);
  const dir = workDir(item, "subs");

  const src = await localMaster(item, item.upstream?.edit, dir, "edit.mp4");
  const local = src.path;

  // One transparent PNG per ≤14-char line; time allocated by char share of the
  // clip. Burned via overlay+enable (this ffmpeg build has no libass/drawtext).
  const gap = item.upstream.voice.voiceMeta.gap ?? GAP;
  let offset = 0;
  const overlays = []; // { png, start, end }
  // 剪辑那边念到哪个词就推到录屏的哪块 —— 这些词在字幕里同时高亮
  const focus = Array.isArray(item.upstream?.edit?.focus) ? item.upstream.edit.focus : [];
  const hlFor = (text, start, end) => focus.find((f) => text.includes(f.word) && f.t >= start - 0.6 && f.t <= end + 0.2)?.word ?? null;
  let highlighted = 0;
  let byWords = 0;
  const decisions = [];
  // 每拍在成片里的开始时间以剪辑的时间轴为准(你拖过停顿、插过纯画面,就和配音自带的留白不一样了)
  const tl = new Map((item.upstream?.edit?.timeline || []).map((x) => [x.name, x]));
  for (const m of meta) {
    if (tl.has(m.name)) offset = tl.get(m.name).start;
    mark(item, m.name, "渲字幕行");
    // 首选 MiniMax 给的字级时间戳;老项目没有就退回按字数估算
    const timed = Array.isArray(m.words) && m.words.length ? linesFromWords(m.words) : null;
    const before = overlays.length;
    if (timed?.length) {
      byWords += 1;
      for (const l of timed) {
        const png = join(dir, `line-${String(overlays.length).padStart(3, "0")}.png`);
        const hl = hlFor(l.text, offset + l.start, offset + Math.min(l.end, m.dur));
        if (hl) highlighted++;
        await renderSubLine(l.text, size, png, "dark", hl);
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
    decisions.push(
      timed?.length
        ? { beat: m.name, topic: "字幕", choice: `${overlays.length - before} 行 · 跟人声逐字对齐` }
        : { beat: m.name, topic: "字幕", choice: `${overlays.length - before} 行 · 按字数估算时间`, why: "这拍没有字级时间戳,字幕可能比人声早或晚", warn: true },
    );
    offset += m.dur + (m.gap ?? gap);
  }
  await closeBrowser();

  mark(item, null, "烧录字幕");
  ensureDisk(dir, 0.5, "烧录字幕");
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
  const vidDurEarly = await ffprobeDur(out);
  mark(item, null, "压审核用的预览");
  const preview = await makePreview(out, join(dir, "subs-preview.mp4"), item.aspect);
  const master = await keepMaster(out, dir, "subs");
  console.log("  [subtitles] uploading preview…");
  mark(item, null, "上传预览");
  const { url } = await uploadP(item, preview, `subs-${stamp()}.mp4`, "上传预览");
  const warn = [];
  if (!overlays.length) warn.push("一行字幕都没有");
  const lastEnd = overlays.length ? overlays.at(-1).end : 0;
  const vidDur = vidDurEarly;
  if (overlays.length && vidDur - lastEnd > 3) warn.push(`结尾 ${(vidDur - lastEnd).toFixed(1)}s 没有字幕`);
  const warnLine = warn.length ? `\n⚠ 字幕自检:${warn.join(";")}` : "";
  const timing = byWords === meta.length ? "跟着人声逐字对齐" : byWords ? `${byWords}/${meta.length} 拍逐字对齐,其余按字数估算` : "按字数估算(这条片没有字级时间戳)";
  decisions.unshift(
    { topic: "底片", choice: `剪辑阶段 ${vtime(editVideo) ?? "(时间不明)"} 那版粗剪`, why: src.fromPreview ? "渲染机上找不到那版的高清母版,用 720p 预览当底片 —— 画质会差一些,重出一次剪辑就好" : "直接用渲染机上的高清母版,字幕烧在这版上;粗剪之后再改,字幕要跟着重出", warn: src.fromPreview },
    { topic: "审核用", choice: "720p 预览", why: "高清版留在渲染机上,润色时才整条上传" },
    { topic: "断行", choice: `${overlays.length} 行,每行最多 ${SUB_MAX} 字`, why: `按逗号句号断(顿号不断),超长均分,不到 ${SUB_MIN} 个字的碎片并进上一行;香槟金字 + 墨蓝描边,放在抖音底部按钮区上面` },
    { topic: "对齐", choice: timing, warn: byWords < meta.length },
    ...(focus.length ? [{ topic: "高亮", choice: `${highlighted} 处`, why: `镜头推到录屏某块时,字幕里念到的那个词变黄加粗(${focus.map((f) => `「${f.word}」`).join("")})` }] : []),
    ...warn.map((w) => ({ topic: "自检", choice: w, warn: true })),
  );
  return {
    video: url,
    preview: true,
    master,
    subs: overlays.map((o) => ({ text: o.text, start: o.start, end: o.end })),
    decisions,
    note: `字幕已烧录(${overlays.length} 行,${timing})。错字/断句/位置请审。${warnLine}`,
  };
}

// ── 死帧质检(学 MuseDock frameSampling.js)──────────────────────────
// 每秒抽 2 帧、缩成灰度小图:相邻两帧几乎一样 = 这段画面没在动;亮度起伏和边缘都很弱 = 画面近乎一片纯色。
// 按拍统计 —— 一拍里 75% 以上的时间不动,就是"入场演完之后静止十几秒"那种毛病。
async function deadFrames(file, beats, vertical) {
  const w = vertical ? 90 : 160, h = vertical ? 160 : 90;
  const buf = await ffmpegRaw(["-i", file, "-vf", `fps=2,scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"]);
  const N = w * h;
  const n = Math.floor(buf.length / N);
  const stats = [];
  for (let k = 0; k < n; k++) {
    const f = buf.subarray(k * N, (k + 1) * N);
    let sum = 0, sq = 0, edge = 0;
    for (let i = 0; i < N; i++) { sum += f[i]; sq += f[i] * f[i]; }
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      edge += (Math.abs(f[i + 1] - f[i]) + Math.abs(f[i + w] - f[i])) / 2;
    }
    const mean = sum / N;
    const std = Math.sqrt(Math.max(0, sq / N - mean * mean));
    let diff = 0, changed = 0;
    if (k > 0) {
      const p = buf.subarray((k - 1) * N, k * N);
      for (let i = 0; i < N; i++) { const d = Math.abs(f[i] - p[i]); diff += d; if (d > 8) changed++; }
    }
    stats.push({ t: k / 2, std, edge: edge / ((w - 1) * (h - 1)), diff: k ? diff / N : null, changed: k ? changed / N : null });
  }
  return beats.map((b) => {
    const inBeat = stats.filter((s) => s.t >= b.start && s.t < b.start + b.dur);
    const pairs = inBeat.filter((s) => s.diff != null && s.t - 0.5 >= b.start);
    const still = pairs.filter((s) => s.diff < 1.0 && s.changed < 0.015).length;
    const flat = inBeat.filter((s) => s.std < 12 && s.edge < 8).length;
    return { ...b, stillPct: pairs.length ? still / pairs.length : 0, flatPct: inBeat.length ? flat / inBeat.length : 0 };
  });
}

async function polish(item) {
  const upv = item.upstream?.subtitles?.video ? item.upstream.subtitles : item.upstream?.edit;
  const video = upv?.video;
  if (!video) throw new Error("上游没有成片视频");

  // ── 成片自动体检(学 MuseDock visualQaService):画幅/时长/黑屏/冻结/抽帧总评 ──
  const dir = workDir(item, "polish");
  const src = await localMaster(item, upv, dir, "final.mp4");
  const local = src.path;
  const qa = { issues: [] };
  try {
    mark(item, null, "体检画幅和时长");
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

    mark(item, null, "体检黑屏");
    const black = await ffmpegOut(["-i", local, "-vf", "blackdetect=d=0.6:pix_th=0.10", "-an", "-f", "null", "-"]);
    qa.blackIntervals = (black.match(/black_start:/g) || []).length;
    if (qa.blackIntervals > 0) qa.issues.push(`检测到 ${qa.blackIntervals} 段疑似黑屏(>0.6s)`);

    mark(item, null, "体检冻结");
    const freeze = await ffmpegOut(["-i", local, "-vf", "freezedetect=n=-60dB:d=2", "-an", "-f", "null", "-"]);
    qa.freezeIntervals = (freeze.match(/freeze_start:/g) || []).length;
    if (qa.freezeIntervals > 0) qa.issues.push(`检测到 ${qa.freezeIntervals} 段画面冻结(>2s)`);

    mark(item, null, "体检死帧");
    const vm = item.upstream?.voice?.voiceMeta?.clips || [];
    const etl = item.upstream?.edit?.timeline;
    let at = 0;
    const beatsT = etl?.length
      ? etl.map((x) => ({ name: x.name, start: x.start, dur: x.dur + x.gap }))
      : vm.map((c) => { const b = { name: c.name, start: at, dur: c.dur + (c.gap ?? GAP) }; at += b.dur; return b; });
    qa.dead = beatsT.length ? await deadFrames(local, beatsT, item.aspect !== "16:9") : [];
    const stillBeats = qa.dead.filter((b) => b.dur >= 3 && b.stillPct >= 0.75);
    const flatBeats = qa.dead.filter((b) => b.flatPct > 0.4);
    if (stillBeats.length) qa.issues.push(`${stillBeats.map((b) => b.name).join("/")} 大部分时间画面不动`);
    if (flatBeats.length) qa.issues.push(`${flatBeats.map((b) => b.name).join("/")} 画面近乎一片纯色`);

    // 抽 3 帧给视觉模型做总评
    mark(item, null, "抽帧给 AI 总评");
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

  const srcName = item.upstream?.subtitles?.video ? "字幕阶段" : "剪辑阶段";
  // 整条高清成片只在这里上传一次(交付打包用它);前面两步给你审的都是 720p 预览
  mark(item, null, "上传高清成片");
  const { url: finalUrl } = await uploadP(item, local, `final-${stamp()}.mp4`, "上传高清成片");
  const decisions = [
    {
      topic: "体检的成片",
      choice: `${srcName} ${vtime(video) ?? "(时间不明)"} 那版`,
      why: src.fromPreview ? "渲染机上找不到高清母版,体检和交付用的是 720p 预览 —— 重出一次字幕就能换回高清" : "高清版,交付打包用的也是这一版(这一步才整条上传)",
      warn: src.fromPreview,
    },
    ...(qa.error
      ? [{ topic: "体检", choice: "没跑成", why: qa.error, warn: true }]
      : [
          { topic: "画幅", choice: qa.aspectOk ? "对" : "不对", warn: !qa.aspectOk },
          { topic: "时长", choice: `${qa.durationSec}s,偏离目标 ${qa.deviationPct}%`, why: "超过 25% 标黄", warn: qa.deviationPct > 25 },
          { topic: "黑屏", choice: `${qa.blackIntervals} 段`, why: "超过 0.6s 的黑画面", warn: qa.blackIntervals > 0 },
          { topic: "冻结", choice: `${qa.freezeIntervals} 段`, why: "超过 2s 画面完全不动(冻帧补时长会被算进来)", warn: qa.freezeIntervals > 0 },
          ...(qa.dead || [])
            .filter((b) => (b.dur >= 3 && b.stillPct >= 0.75) || b.flatPct > 0.4)
            .map((b) => ({
              beat: b.name,
              topic: b.flatPct > 0.4 ? "纯色" : "不动",
              choice: b.flatPct > 0.4 ? `${Math.round(b.flatPct * 100)}% 的时间画面近乎一片纯色` : `${Math.round(b.stillPct * 100)}% 的时间画面几乎不动(这拍 ${s1(b.dur)})`,
              why: b.flatPct > 0.4 ? "亮度起伏和边缘都很弱,多半是黑屏/白屏或空卡" : "每秒抽 2 帧比较,相邻两帧几乎一样;长拍可以在剪辑里开「分步出现」或者换运镜",
              warn: true,
            })),
          ...((qa.dead || []).length && !(qa.dead || []).some((b) => (b.dur >= 3 && b.stillPct >= 0.75) || b.flatPct > 0.4)
            ? [{ topic: "死帧", choice: "每一拍都在动", why: `抽了 ${qa.dead.length} 拍,没有一拍大部分时间静止` }]
            : []),
          { topic: "AI 总评", choice: qa.vision?.ok === false ? "有问题" : "通过", why: (qa.vision?.issues || []).join(";") || "抽了开头/中间/结尾 3 帧", warn: qa.vision?.ok === false },
        ]),
  ];
  return {
    video: finalUrl,
    qa,
    decisions,
    note: `${qaLine}\n要微调(节奏/某句/某画面)就打回写批注;满意就通过,进入交付打包。${qa.issues.length ? "\n⚠ " + qa.issues.join(" / ") : ""}`,
  };
}

async function deliver(item) {
  const up = item.upstream || {};
  const t = up.topic?.topic || { angle: item.topic, hook: "" };
  const scriptText = up.script?.script || "";
  const size = sizeFor(item.aspect);

  mark(item, null, "写封面标题");
  const cov = await chatJSON(guided(item, PROMPTS.cover(item, t, scriptText)), { temperature: 0.8 }, validateCover);
  const dir = workDir(item, "deliver");
  const png = join(dir, "cover.png");
  mark(item, null, "渲封面");
  const coverRender = await renderCard({ kicker: "", big: cov.main, sub: cov.sub, type: "text" }, size, png);
  if (coverRender.layout?.length) console.log(`  [deliver] 封面排版:${coverRender.layout.join(";")}`);
  await closeBrowser();
  mark(item, null, "上传封面");
  const { url: coverUrl } = await upload(item.projectId, png, `cover-${stamp()}.png`);

  mark(item, null, "写发布文案");
  const caption = await chatJSON(guided(item, PROMPTS.caption(item, t, scriptText)), { temperature: 0.7 }, validateCaption);
  mark(item, null, "审封面");
  const coverQa = await reviewImage(png, "审这张短视频封面:1)主标题 0.5 秒内能不能读清 2)文字有没有被裁/溢出 3)有没有低俗震惊体感");
  const warnLine = coverQa.ok ? "" : `\n⚠ 封面自检:${(coverQa.issues || []).join(";")}`;
  const decisions = [
    { topic: "封面主标题", choice: String(cov.main ?? ""), why: cov.sub ? `副标题:${cov.sub}` : "AI 按选题和脚本写的" },
    ...repairDecisions(cov, "封面文字"),
    ...repairDecisions(caption, "发布文案"),
    ...(coverRender.layout?.length ? [{ topic: "封面排版", choice: "有排版问题", why: coverRender.layout.join(";"), warn: true }] : []),
    { topic: "封面审稿", choice: coverQa.ok ? "通过" : "有问题", why: (coverQa.issues || []).join(";") || "主标题 0.5 秒内读得清、没被裁", warn: !coverQa.ok },
    { topic: "文案", choice: String(caption?.title ?? ""), why: `${(caption?.hashtags || []).length} 个话题标签` },
    { topic: "打包", choice: "全部通过时打包", why: "视频取打包那一刻最新的成片;之后改了剪辑,全部重新通过时会自动换成新成片" },
  ];
  // 封面和文案里不许出网址(所有平台);话题标签里的品牌名不算
  const pubText = [cov.main, cov.sub, caption?.title, caption?.desc].filter(Boolean).join("\n");
  const pubUrls = pubText.match(new RegExp(URL_RE.source, "gi")) || [];
  if (pubUrls.length) decisions.push({ topic: "网址", choice: `封面/文案里有 ${[...new Set(pubUrls)].join("、")}`, why: "片内和发布文案都不许出网址 —— 打回改掉", warn: true });
  return {
    cover: coverUrl,
    caption,
    decisions,
    note: `封面 + 抖音文案。通过后自动打包(视频+封面+文案 zip)可下载。${warnLine}`,
  };
}

export const STAGES = { topic, script, footage, voice, edit, subtitles, polish, deliver };
