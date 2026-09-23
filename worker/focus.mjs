// 录屏跟着台词对焦(学 MuseDock focusCuePlanner / cameraMath / sceneImageSequenceDom):
// 视觉模型先在录屏关键帧上标出"能被口播提到的区域"(标题、按钮、分数、卡片),
// 念到某个区域的名字时,镜头推过去;字幕里这个词同时高亮。
// 视觉模型标的框没人核对过,按 MuseDock 的 C 级处理:框放大 1.5 倍、最大推 1.5 倍、最小 1.15 倍,
// 目标占画面 72%(留上下文);同一个词对上两个区域 → 不推(宁可不推,不推错)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatJSON } from "./llm.mjs";
import { ffmpeg, ffprobeInfo } from "./ffmpeg.mjs";
import { fileSha } from "./segcache.mjs";
import { spokenIndex, findSpoken } from "./reveal.mjs";

const VISION_MODEL = process.env.VISION_MODEL || "google/gemini-2.5-flash-lite";
const FILL = 0.72;
const EXPAND = 1.5;
const MIN_ZOOM = 1.15;
const MAX_ZOOM = 1.5;

// Gemini 标框有自己的习惯:box_2d = [ymin, xmin, ymax, xmax],0-1000 —— 让它按习惯给,准一些,
// 拿回来再换成 {x,y,w,h} 比例。(第一次让它给 x/y/w/h,它照样回了这个格式,调用记录里看到的)
function validateRegions(o) {
  if (!Array.isArray(o?.regions)) return ['要返回 {"regions":[...]}'];
  const out = [];
  o.regions.forEach((r, i) => {
    const b = r?.box_2d;
    if (!String(r?.label ?? "").trim()) out.push(`regions 第 ${i + 1} 个没有 label`);
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(Number(v)))) {
      out.push(`regions 第 ${i + 1} 个的 box_2d 要是 [ymin, xmin, ymax, xmax] 四个数`);
    } else if (b.some((v) => v < 0 || v > 1000) || b[0] >= b[2] || b[1] >= b[3]) {
      out.push(`regions 第 ${i + 1} 个的 box_2d ${JSON.stringify(b)} 不对:要在 0-1000 之间,并且 ymin<ymax、xmin<xmax`);
    }
  });
  return out;
}

async function regionsOnFrame(png) {
  const b64 = readFileSync(png).toString("base64");
  const res = await chatJSON(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `这是一个手机 App 录屏(或截图)的一帧。找出画面里口播可能会提到的区域:标题、按钮、分数/数字、标签、卡片、图表,最多 12 个。
每个区域给:
- label:区域里最主要的那几个字,原文照抄,不要概括
- texts:区域里其它读得清的字,原文照抄(数组,可空)
- box_2d:[ymin, xmin, ymax, xmax],0-1000
- confidence:0-1
只返回 JSON:{"regions":[...]}`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    { model: VISION_MODEL, temperature: 0.1, maxTokens: 2000 },
    validateRegions,
  );
  return (res.regions || [])
    .filter((r) => !validateRegions({ regions: [r] }).length)
    .map((r) => {
      const [y0, x0, y1, x1] = r.box_2d.map(Number);
      return { label: r.label, texts: r.texts || [], confidence: r.confidence, box: { x: x0 / 1000, y: y0 / 1000, w: (x1 - x0) / 1000, h: (y1 - y0) / 1000 } };
    });
}

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

/**
 * 标出一个素材里的区域。录屏取 25% / 70% 两帧,只留两帧里位置差不多(IoU ≥ 0.35)的区域 ——
 * 录屏会滚动,一闪而过的东西推过去也对不上。按文件内容缓存,同一个素材只问一次。
 */
export async function detectRegions(src, kind, dir) {
  const sha = await fileSha(src);
  const cache = join(dir, `regions-${sha.slice(0, 12)}.json`);
  if (existsSync(cache)) {
    try {
      return JSON.parse(readFileSync(cache, "utf8"));
    } catch {
      /* 重新问 */
    }
  }
  let regions;
  if (kind === "video") {
    const info = await ffprobeInfo(src);
    const d = parseFloat(info.format?.duration) || 1;
    const frames = [];
    for (const [k, at] of [[0, 0.25], [1, 0.7]]) {
      const png = join(dir, `focus-${sha.slice(0, 8)}-${k}.png`);
      await ffmpeg(["-ss", (d * at).toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", png]);
      frames.push(png);
    }
    const [a, b] = [await regionsOnFrame(frames[0]), await regionsOnFrame(frames[1])];
    regions = a
      .map((r) => {
        const twin = b.find((x) => iou(r.box, x.box) >= 0.35);
        if (!twin) return null;
        const box = { x: (r.box.x + twin.box.x) / 2, y: (r.box.y + twin.box.y) / 2, w: (r.box.w + twin.box.w) / 2, h: (r.box.h + twin.box.h) / 2 };
        return { label: r.label, texts: [...new Set([...(r.texts || []), twin.label, ...(twin.texts || [])])], box, confidence: Math.min(r.confidence ?? 0.5, twin.confidence ?? 0.5) };
      })
      .filter(Boolean);
  } else {
    const png = join(dir, `focus-${sha.slice(0, 8)}-0.png`);
    await ffmpeg(["-i", src, "-frames:v", "1", "-vf", "scale='min(1080,iw)':-2", png]);
    regions = await regionsOnFrame(png);
  }
  writeFileSync(cache, JSON.stringify(regions));
  return regions;
}

/** 素材上的比例框 → 成片画面上的像素框(按这一拍实际的进画方式) */
export function mapBox(box, { W, H, srcW, srcH, fit }) {
  let s, ox, oy;
  if (fit === "cover") {
    s = Math.max(W / srcW, H / srcH);
    ox = (W - srcW * s) / 2;
    oy = (H - srcH * s) / 2;
  } else {
    s = Math.min((W * 0.94) / srcW, (H * 0.94) / srcH);
    ox = (W - srcW * s) / 2;
    oy = (H - srcH * s) / 2;
  }
  return { x: ox + box.x * srcW * s, y: oy + box.y * srcH * s, w: box.w * srcW * s, h: box.h * srcH * s };
}

/**
 * 这一拍念到了哪些区域 → 推镜头的计划。
 * 返回 { cues: [{ t, until, label, word, zoom, cx, cy }], notes: [...] }(时间都相对这一拍开头)
 */
export function planFocus(regions, words, beatDur, geom) {
  const index = spokenIndex(words);
  const hits = [];
  for (const r of regions) {
    for (const name of [r.label, ...(r.texts || [])]) {
      const h = findSpoken(index, name, 0);
      if (h && h.whole) {
        hits.push({ r, t: h.t, word: h.matched, charIdx: h.charIdx });
        break;
      }
    }
  }
  const notes = [];
  // 同一处字对上两个区域 = 分不清指的是哪个,不推
  const clean = hits.filter((h) => {
    const twins = hits.filter((x) => x.charIdx === h.charIdx);
    if (twins.length > 1) notes.push(`「${h.word}」同时对上 ${twins.length} 个区域,分不清,不推`);
    return twins.length === 1;
  });
  clean.sort((a, b) => a.t - b.t);
  const cues = [];
  const { W, H } = geom;
  for (const h of clean) {
    if (h.t < 0.3 || h.t > beatDur - 1.0) continue;
    if (cues.length && h.t - cues[cues.length - 1].t < 1.5) continue;
    const box = mapBox(h.r.box, geom);
    const bw = box.w * EXPAND, bh = box.h * EXPAND;
    const zoom = Math.min(MAX_ZOOM, FILL / Math.max(bw / W, bh / H));
    if (zoom < MIN_ZOOM) {
      notes.push(`「${h.word}」那块本来就占了大半个画面,不用推`);
      continue;
    }
    // 推完之后目标要在字幕带上面:推 zoom 倍、以目标为中心时,目标下沿要高于画面 85%
    const cy = box.y + box.h / 2;
    const viewH = H / zoom;
    const top = Math.max(0, Math.min(H - viewH, cy - viewH / 2));
    const bottomOnScreen = ((box.y + box.h - top) / viewH) * H;
    if (bottomOnScreen > H * 0.85) {
      notes.push(`「${h.word}」那块太靠下,推过去会被字幕挡住,不推`);
      continue;
    }
    cues.push({ t: Math.max(0.2, h.t - 0.15), label: h.r.label, word: h.word, zoom: Number(zoom.toFixed(2)), cx: box.x + box.w / 2, cy });
    if (cues.length >= 2) break;
  }
  cues.forEach((c, i) => (c.until = i + 1 < cues.length ? cues[i + 1].t : beatDur));
  return { cues: cues.filter((c) => c.until - c.t >= 1.0), notes };
}

const ease = (P) => `(if(lt(${P},0.5),4*${P}*${P}*${P},1-pow(-2*${P}+2,3)/2))`;

// 关键帧 [{f, z, cx, cy}] → zoompan 的分段缓动表达式
function piecewise(keys, pick) {
  let expr = `${pick(keys[keys.length - 1])}`;
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const va = pick(a), vb = pick(b);
    const span = Math.max(1, b.f - a.f);
    const seg = Math.abs(va - vb) < 1e-6 ? `${va}` : `(${va}+(${(vb - va).toFixed(4)})*${ease(`((on-${a.f})/${span})`)})`;
    expr = `if(lt(on,${b.f}),${seg},${expr})`;
  }
  return `if(lt(on,${keys[0].f}),${pick(keys[0])},${expr})`;
}

/**
 * 推镜头的 zoompan 滤镜(接在进画链后面,输入是 W×H 的画面)。
 * 推进 0.45-0.8s(窗口的 40%),停住;时间够就用 0.6s 拉回全景,不够就停在那儿到这拍结束。
 */
export function focusZoompan(cues, { W, H, fps, frames }) {
  const keys = [{ f: 0, z: 1, cx: W / 2, cy: H / 2 }];
  for (const c of cues) {
    const f0 = Math.round(c.t * fps);
    const win = c.until - c.t;
    const din = Math.min(0.8, Math.max(0.45, win * 0.4));
    const f1 = Math.round((c.t + din) * fps);
    keys.push({ f: f0, z: keys[keys.length - 1].z, cx: keys[keys.length - 1].cx, cy: keys[keys.length - 1].cy });
    keys.push({ f: f1, z: c.zoom, cx: c.cx, cy: c.cy });
    const back = c.until - (c.t + din) >= 1.2;
    const isLast = c === cues[cues.length - 1];
    if (back && isLast) {
      const fb = Math.round((c.until - 0.7) * fps);
      keys.push({ f: fb, z: c.zoom, cx: c.cx, cy: c.cy });
      keys.push({ f: Math.min(frames - 1, fb + Math.round(0.6 * fps)), z: 1, cx: W / 2, cy: H / 2 });
    } else {
      keys.push({ f: Math.round((c.until - 0.05) * fps), z: c.zoom, cx: c.cx, cy: c.cy });
    }
  }
  // 关键帧帧号必须单调
  for (let i = 1; i < keys.length; i++) keys[i].f = Math.max(keys[i].f, keys[i - 1].f + 1);
  const S = 1.5; // 超采样:输入先放大 1.5 倍,推的时候不糊
  const z = piecewise(keys, (k) => Number(k.z.toFixed(4)));
  const cx = piecewise(keys, (k) => Number((k.cx * S).toFixed(1)));
  const cy = piecewise(keys, (k) => Number((k.cy * S).toFixed(1)));
  const x = `max(0,min(iw-iw/zoom,${cx}-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,${cy}-ih/zoom/2))`;
  return `scale=${Math.round(W * S / 2) * 2}:${Math.round(H * S / 2) * 2}:flags=bicubic,zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps},setsar=1`;
}
