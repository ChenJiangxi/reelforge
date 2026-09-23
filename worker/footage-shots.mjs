// 素材阶段(新):每拍排 1-4 个动态镜头(shots/ 里的 Remotion 模板),代替原来"一拍一张字卡"。
// 这一步只定"每拍切几个镜头、每个镜头用什么模板、上面写什么",出每拍一张缩略图;
// 真正按配音逐字时间渲动画在剪辑阶段做(那时才知道每拍多长、每个字几秒念到)。
//
// 哪些拍不交给 LLM:
//   - 她在网页上改过镜头的拍(脚本阶段 clips[i].shots)—— 原样用,永远不被覆盖
//   - 她指定整拍用某个素材的拍(clips[i].asset)
//   - 台词和画面简报都没变、也没有打回批注的拍 —— 沿用上一版
import { join } from "node:path";
import { chatJSON } from "./llm.mjs";
import { upload, downloadCached } from "./board.mjs";
import { ffmpeg, ffmpegRaw } from "./ffmpeg.mjs";
import { planPrompt, validatePlan, normalizeShots, describeShots, TPL_LABEL, SHOT_THEMES, SCENE_ON } from "./shots.mjs";
import { previewBeat, shotCountFor, orderByFrom } from "../shots/timing.mjs";
import { renderBeatStill } from "./remotion/render.mjs";
import { sceneImage, sceneKey, dataUrl, pool, castImage } from "./images.mjs";
import { repairDecisions } from "./validate.mjs";

const OLD_THEME = { dark: "ink", gradient: "dusk", paper: "paper" };

/** 平均亮度 0-1(视频取第 1 秒那一帧) */
async function meanLuma(path, kind) {
  const args = [...(kind === "video" ? ["-ss", "1"] : []), "-i", path, "-frames:v", "1", "-vf", "scale=64:-2,format=gray", "-f", "rawvideo", "-"];
  const buf = await ffmpegRaw(args);
  if (!buf?.length) throw new Error("no frame");
  let sum = 0;
  for (const b of buf) sum += b;
  return sum / buf.length / 255;
}

/** 缩略图挑哪一帧:第一个模板镜头快演完的时候(元素都出来了) */
function stillFrame(spans, shots) {
  const k = spans.findIndex((sp) => shots[sp.i]?.tpl);
  if (k < 0) return null;
  const sp = spans[k];
  return { frame: sp.fromFrame + Math.max(0, sp.frames - 4), k };
}

export async function footageShots(item, { mark, workDir, sizeFor, stamp }) {
  const clips = item.upstream?.script?.clips;
  if (!clips?.length) throw new Error("上游脚本没有 clips");
  const size = sizeFor(item.aspect);
  const assets = item.assets || [];
  const assetNames = assets.map((a) => a.name);
  const settings = item.upstream?.script?.editSettings || {};
  const prevCards = item.artifacts?.cards || [];
  const prevImages = item.artifacts?.images || [];
  const prevByName = new Map(prevCards.map((c, i) => [c.name, { ...c, _img: prevImages[i] }]));
  const prevTheme = prevCards.find((c) => c.theme)?.theme;
  const decisions = [];
  if (item.reviewNote) decisions.push({ topic: "批注", choice: "没被你锁定的拍全部按批注重新排镜头", why: item.reviewNote.slice(0, 80) });

  // 素材是深色还是浅色(配色要跟着素材走,不然亮暗来回跳):抽一帧量平均亮度
  for (const a of assets) {
    if (a.tone || (a.kind !== "video" && a.kind !== "image")) continue;
    try {
      const local = await downloadCached(a.url, join(workDir(item, "assets"), a.name));
      a.tone = (await meanLuma(local, a.kind)) < 0.42 ? "dark" : "light";
    } catch {
      /* 量不出来就不标 */
    }
  }

  // 1) 分出哪些拍要 LLM 排
  const fixed = new Map(); // name → {shots, by, why}
  const want = [];
  clips.forEach((c, i) => {
    const prev = prevByName.get(c.name);
    if (Array.isArray(c.shots) && c.shots.length) {
      fixed.set(c.name, { shots: normalizeShots(c.shots), by: "you", why: "你在网页上改过这拍的镜头,原样用" });
    } else if (c.asset) {
      fixed.set(c.name, { shots: [{ asset: c.asset, from: "" }], by: "you", why: "你指定这拍整段用这个素材" });
    } else if (!item.reviewNote && prev?.shots?.length && prev.text === c.text && (prev.visualRev ?? 0) === (c.visualRev ?? 0)) {
      fixed.set(c.name, { shots: normalizeShots(prev.shots), by: "reuse", why: "台词和画面简报都没变,沿用上一版的镜头" });
    } else {
      want.push({ name: c.name, beat: c.beat, text: c.text, visual: c.visual, order: i });
    }
  });

  // 2) LLM 整片一次排(看得到全片才管得住"别扎堆")
  let theme = settings.theme || prevTheme || null;
  let planned = new Map();
  const prevCast = item.artifacts?.cast?.main || null;
  let castDesc = prevCast?.desc || null;
  if (want.length) {
    mark(item, null, `排镜头(${want.length} 拍)`);
    const material = item.upstream?.topic?.material || item.upstream?.topic?.topic?.material || "";
    const source = `${clips.map((c) => c.text).join("\n")}\n${material}\n${clips.map((c) => c.visual || "").join("\n")}`;
    const fixedList = clips.map((c, i) => ({ c, i })).filter(({ c }) => fixed.has(c.name)).map(({ c, i }) => ({ name: c.name, text: c.text, shots: fixed.get(c.name).shots, order: i }));
    const out = await chatJSON(
      planPrompt(item, want, fixedList, { assets, material, note: item.reviewNote || "", theme }),
      { temperature: 0.6, maxTokens: 9000 },
      validatePlan(want, new Map(fixedList.map((f) => [f.name, f.shots])), source, assetNames, clips.map((c) => c.name), new Map(clips.map((c) => [c.name, c.text])), !!castDesc && !item.reviewNote),
    );
    // 主角:有打回批注时可以换人;没有批注就沿用上一版的主角(免得每次重做换一张脸)
    const nextCast = String(out.cast?.main ?? "").trim();
    if (nextCast && (!castDesc || item.reviewNote)) castDesc = nextCast;
    decisions.push(...repairDecisions(out, "排镜头"));
    if (!settings.theme && SHOT_THEMES.includes(out.theme)) theme = out.theme;
    for (const b of out.beats || []) if (b?.name) planned.set(b.name, normalizeShots(b.shots));
  }
  theme = OLD_THEME[theme] || theme || "ink";
  decisions.push({ topic: "配色", choice: { ink: "深墨蓝 + 香槟金", paper: "暖纸 + 朱红", dusk: "暗紫 + 暖橙" }[theme] ?? theme, why: settings.theme ? "你定的" : prevTheme && !want.length ? "沿用上一版" : "按内容调性选的,全片一套" , key: "theme", value: theme, by: settings.theme ? "you" : "auto" });

  // 3) 画面镜头的配图:全片一起生成(4 张并发),按描述+风格+画幅缓存,同一张不重复花钱
  const style = settings.imageStyle || "photo";
  const finalShots = new Map();
  for (const c of clips) finalShots.set(c.name, fixed.get(c.name)?.shots || planned.get(c.name) || []);
  const sceneJobs = [];
  for (const [beat, shots] of finalShots) shots.forEach((s, k) => s.tpl === "scene" && s.p?.prompt && sceneJobs.push({ beat, k, s }));
  // 配图没开(默认):不生成任何图,不花一分钱。已经有图的画面镜头照旧用它的图
  if (!SCENE_ON && sceneJobs.length) {
    decisions.push({ topic: "配图", choice: `配图没开,${sceneJobs.length} 个画面镜头不生成新图`, why: "生图要花钱,要你同意用哪家之后才打开(SCENE_IMAGES=on);已经有图的照旧用", warn: true });
    sceneJobs.length = 0;
  }
  const localImg = new Map(); // key → 本地路径
  let imgNew = 0;
  let imgCost = 0;
  // 主角定妆照:先出这一张,后面有主角的画面都拿它当参考(同一个人)
  let cast = null;
  const needCast = SCENE_ON && sceneJobs.some((j) => j.s.p.who === "main");
  if (needCast && castDesc) {
    mark(item, null, "出主角定妆照");
    try {
      const r = await castImage(castDesc, { style, aspect: item.aspect, workRoot: workDir(item, "") });
      if (!r.cached) {
        imgNew++;
        imgCost += Number(r.cost) || 0;
      }
      const src = prevCast?.key === r.key && prevCast?.src ? prevCast.src : (await upload(item.projectId, r.path, `cast-${r.key}.jpg`)).url;
      cast = { desc: castDesc, key: r.key, src, path: r.path };
    } catch (e) {
      decisions.push({ topic: "主角", choice: "定妆照没生成出来,各张画面里的人可能不是同一个", why: String(e.message).slice(0, 140), warn: true });
    }
  }
  if (sceneJobs.length) {
    mark(item, null, `生成画面(${sceneJobs.length} 张)`);
    await pool(sceneJobs, 4, async ({ beat, s }) => {
      try {
        const ref = s.p.who === "main" && cast ? { path: cast.path, key: cast.key } : null;
        const r = await sceneImage(s.p.prompt, { style, aspect: item.aspect, workRoot: workDir(item, ""), ref });
        localImg.set(r.key, r.path);
        if (!r.cached) {
          imgNew++;
          imgCost += Number(r.cost) || 0;
        }
        if (s.p.srcKey !== r.key || !s.p.src) {
          const up = await upload(item.projectId, r.path, `scene-${r.key}.jpg`);
          s.p = { ...s.p, src: up.url, srcKey: r.key };
        }
      } catch (e) {
        decisions.push({ beat, topic: "画面", choice: "这张图没生成出来,先用纯色底", why: String(e.message).slice(0, 140), warn: true });
      }
    });
    decisions.push({ topic: "配图", choice: `${sceneJobs.length} 张画面 · 新生成 ${imgNew} 张`, why: `风格:${{ photo: "写实电影感", ink: "国风水墨", glow: "梦幻光影" }[style] ?? style}${settings.imageStyle ? "(你定的)" : "(默认)"};${imgNew ? `这次花了约 ${(imgCost || imgNew * 0.039).toFixed(2)} 美元` : "全部用的缓存"}`, key: "imageStyle", value: style, by: settings.imageStyle ? "you" : "auto" });
  }
  /** 渲缩略图用的镜头:画面镜头换成本地图的 data URL */
  const forRender = (shots) =>
    shots.map((s) => {
      if (s.tpl !== "scene" || !s.p?.prompt) return s;
      const path = localImg.get(sceneKey(s.p.prompt, style, item.aspect, s.p.who === "main" && cast ? cast.key : ""));
      // 本地没有这张图就不带地址渲(渲染器去服务器取图要登录,会直接失败)
      return path ? { ...s, p: { ...s.p, src: dataUrl(path) } } : { ...s, p: { ...s.p, src: undefined } };
    });

  // 4) 每拍:规整、查素材、出缩略图
  const cards = [];
  const images = [];
  const tplCount = {};
  let shotTotal = 0;
  let secTotal = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const beat = c.name;
    const f = fixed.get(beat);
    let shots = finalShots.get(beat) || [];
    let by = f?.by || "ai";
    let why = f?.why || (item.reviewNote ? "按你的打回批注重新排" : prevByName.get(beat) ? "台词或画面简报变了,重新排" : "这一拍第一次排");
    // 素材库里没有的素材镜头去掉(可能被删了)
    const missing = shots.filter((s) => s.asset && !assetNames.includes(s.asset));
    if (missing.length) {
      decisions.push({ beat, topic: "素材", choice: `「${missing[0].asset}」不在素材库里,这个镜头去掉了`, warn: true });
      shots = shots.filter((s) => !s.asset || assetNames.includes(s.asset));
    }
    if (by === "ai") {
      const o = orderByFrom(shots, c.text);
      if (o.changed) {
        shots = o.shots;
        decisions.push({ beat, topic: "镜头", choice: "按切点在台词里的先后重新排了镜头顺序", why: "AI 给的镜头顺序和它自己写的切点顺序对不上;按切点排,画面才跟得上念到的话" });
      }
    }
    if (!shots.length) {
      // LLM 漏了这拍:给一个最朴素的兜底,别让整个阶段失败
      shots = [{ tpl: "lines", from: "", p: { lines: [String(c.text).replace(/[，。！？,.!?].*$/, "").slice(0, 10) || c.name] } }];
      by = "auto";
      why = "排镜头时这拍漏了,先放一个逐句落兜底 —— 建议在网页上改一下";
      decisions.push({ beat, topic: "镜头", choice: "兜底镜头", why, warn: true });
    }
    const est = previewBeat(c.text, shots);
    shotTotal += est.spans.length;
    secTotal += est.frames / 30;
    for (const s of shots) {
      const k = s.asset ? "asset" : s.tpl;
      tplCount[k] = (tplCount[k] || 0) + 1;
    }
    // 缩略图:同一拍、镜头和配色都没变就不重渲不重传
    const prev = prevByName.get(beat);
    const same = prev && prev._img && prev.theme === theme && JSON.stringify(prev.shots) === JSON.stringify(shots);
    let img = same ? prev._img : null;
    if (!img) {
      const sf = stillFrame(est.spans, shots);
      if (sf) {
        mark(item, beat, "出镜头缩略图");
        const png = join(workDir(item, "cards"), `${beat}-shots.png`);
        const rs = forRender(shots);
        const props = { theme, W: size.width, H: size.height, frames: est.frames, shots: est.spans.map((sp) => ({ tpl: rs[sp.i].tpl || "lines", p: rs[sp.i].p || {}, from: sp.fromFrame, frames: sp.frames, cues: sp.cues })) };
        await renderBeatStill(props, sf.frame, png, { workRoot: workDir(item, "") });
        mark(item, beat, "上传缩略图");
        img = (await upload(item.projectId, png, `shots-${beat}-${stamp()}.png`)).url;
      } else {
        // 整拍都是素材镜头:图片直接用;录屏截第 0.5 秒一帧当缩略图
        const a = assets.find((x) => x.name === shots[0].asset);
        if (a?.kind === "image") img = a.url;
        else if (a) {
          mark(item, beat, "截素材封面帧");
          const local = await downloadCached(a.url, join(workDir(item, "assets"), a.name));
          const png = join(workDir(item, "cards"), `${beat}-poster.png`);
          const { width: w, height: h } = size;
          await ffmpeg(["-ss", "0.5", "-i", local, "-frames:v", "1", "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`, png]);
          img = (await upload(item.projectId, png, `asset-${beat}-poster-${stamp()}.png`)).url;
        } else img = "";
      }
    }
    images.push(img);
    cards.push({ name: beat, text: c.text, visualRev: c.visualRev, type: "shots", theme, shots, by });
    decisions.push({
      beat,
      topic: "镜头",
      choice: describeShots(shots),
      why: `${why};约 ${(est.frames / 30).toFixed(1)} 秒,${shots.length} 个镜头${shots.length !== shotCountFor(c.text) ? `(按时长该切 ${shotCountFor(c.text)} 个左右)` : ""}`,
      by: by === "you" ? "you" : "auto",
    });
  }

  const cardsOnly = Object.entries(tplCount).filter(([k]) => k !== "asset");
  const variety = cardsOnly.length;
  decisions.unshift({
    topic: "构成",
    choice: `${clips.length} 拍 · ${shotTotal} 个镜头 · 平均 ${(secTotal / Math.max(1, shotTotal)).toFixed(1)} 秒换一次画面`,
    why: `用了 ${variety} 种模板:${cardsOnly.sort((a, b) => b[1] - a[1]).map(([k, n]) => `${TPL_LABEL[k] ?? k}×${n}`).join("、")}${tplCount.asset ? `;素材镜头 ${tplCount.asset} 个` : ""}`,
  });
  const lockedN = [...fixed.values()].filter((f) => f.by === "you").length;
  const reusedN = [...fixed.values()].filter((f) => f.by === "reuse").length;
  if (cast) decisions.unshift({ topic: "主角", choice: cast.desc, why: `全片 ${sceneJobs.filter((j) => j.s.p.who === "main").length} 张画面里是她,都拿同一张定妆照当参考,保证是同一个人${prevCast?.key === cast.key ? "(沿用上一版)" : ""}` });
  return {
    images,
    cards,
    cast: cast ? { main: { desc: cast.desc, key: cast.key, src: cast.src } } : prevCast ? { main: prevCast } : undefined,
    decisions,
    note: `${clips.length} 拍、${shotTotal} 个镜头(${item.aspect})。${want.length ? `这次排了 ${want.length} 拍` : "全部沿用"}${reusedN ? `,沿用 ${reusedN} 拍` : ""}${lockedN ? `,${lockedN} 拍是你改过的` : ""}。
镜头的动画在剪辑阶段按配音逐字对时间渲;这里看的是每个镜头放什么、先后顺序。点开一拍可以直接改字、换模板、换一个。`,
  };
}
