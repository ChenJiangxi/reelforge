// 一拍里的几个镜头各从哪一帧开始、镜头里的元素什么时候出现。
// 渲染机(按配音的逐字时间戳)和网页预览(还没配音,按字数估)共用,所以写成纯 JS。
//
// 镜头的起点记成"念到哪句话":shot.from 是这拍台词里的一小段原文,念到它就切到这个镜头。
// 配音重做、语速变了,切点跟着字走。第一个镜头永远从这拍开头开始。

export const FPS = 30;
export const CHARS_PER_SEC = 4.6;
/** 一个镜头最短多少秒(再短看不清) */
export const MIN_SHOT = 1.2;

const PUNCT = /[\p{P}\p{S}\s]/u;
export const cleanText = (s) => [...String(s ?? "")].filter((ch) => !PUNCT.test(ch)).join("");
export const spokenLen = (s) => [...cleanText(s)].length;

/** 这拍大概要切几个镜头:每 3.2 秒左右一个,1-4 个 */
export function shotCountFor(text) {
  const dur = spokenLen(text) / CHARS_PER_SEC;
  return Math.max(1, Math.min(4, Math.round(dur / 3.2)));
}

/** 逐字时间戳 [[字, 开始毫秒], ...] → {text: 去标点的连续字串, times: 每个字的开始秒} */
export function spokenIndex(words) {
  let text = "";
  const times = [];
  for (const [w, b] of words || []) {
    for (const ch of [...String(w)]) {
      if (PUNCT.test(ch)) continue;
      text += ch;
      times.push(b / 1000);
    }
  }
  return { text, times };
}

/** 没有配音时按字数估一个"逐字时间":每个字 1/4.6 秒 */
export function estimatedIndex(text) {
  const t = cleanText(text);
  const chars = [...t];
  return { text: t, times: chars.map((_, i) => i / CHARS_PER_SEC), dur: chars.length / CHARS_PER_SEC };
}

/** label 在第 fromChar 个字之后第一次被念到:整段找不到就找它最长的一段子串(至少 2 个字) */
export function findSpoken(index, label, fromChar = 0) {
  const want = [...cleanText(label)];
  if (want.length < 2 || !index.text) return null;
  const hay = [...index.text];
  for (let n = want.length; n >= 2; n--) {
    for (let s = 0; s + n <= want.length; s++) {
      const piece = want.slice(s, s + n);
      for (let i = fromChar; i + n <= hay.length; i++) {
        let ok = true;
        for (let k = 0; k < n; k++) if (hay[i + k] !== piece[k]) { ok = false; break; }
        if (ok) return { t: index.times[i], charIdx: i, matched: piece.join(""), whole: n === want.length };
      }
    }
  }
  return null;
}

/** 镜头里按出现顺序排的元素文字(用来找"念到它"的时刻)。空串 = 这个位置不找 */
export function cueTexts(tpl, p = {}) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === "string" ? x : x?.text ?? x?.label ?? "");
  switch (tpl) {
    case "lines":
      return arr(p.lines).map(str);
    case "list":
      return arr(p.items).map(str);
    case "evidence":
      return arr(p.items).map(str);
    case "diagram":
      return arr(p.nodes).map((n) => n?.label ?? "");
    case "pillars":
      return arr(p.cols).map((c) => c?.head ?? "");
    case "table":
      return arr(p.rows).map((r) => (Array.isArray(r) ? r.find((c) => cleanText(c).length >= 2) ?? "" : ""));
    case "compare":
      return [p.left?.title ?? "", p.right?.title ?? "", p.verdict ?? ""];
    case "glyph":
      return [arr(p.chips)[0] ?? p.label ?? "", p.note ?? ""];
    case "number":
    case "gauge":
      return [String(p.value ?? "")];
    case "bars":
      return ["", arr(p.highlight)[0] ?? ""];
    case "timeline":
      return [String(p.peak ?? "")];
    case "scene":
      return [p.big ?? ""];
    default:
      return [];
  }
}

/**
 * 给一拍的镜头排时间。
 * @param shots  [{tpl,p,from} | {asset,from}]
 * @param index  spokenIndex(配音逐字时间) 或 estimatedIndex(按字数估)
 * @param beatDur 这拍念多久 + 句尾停顿(秒)
 * @param segDur  这拍实际要渲多长(含给下一刀转场的重叠)
 * @returns {spans:[{i,start,end,frames,fromFrame,cues:[帧],how,cueHits}], notes:[]}
 */
/** 每个镜头的切点在台词里第一次出现的位置(第几个字);第一个镜头 = 0,找不到 = null */
export function fromPositions(shots, index) {
  return shots.map((s, i) => {
    if (i === 0) return { pos: 0, hit: null };
    const hit = s.from ? findSpoken(index, s.from, 0) : null;
    return { pos: hit ? hit.charIdx : null, hit };
  });
}

/**
 * 素材阶段用:LLM 排的镜头内容顺序和切点顺序对不上时(第 2 个镜头写"念到七杀旺切"、第 4 个写"念到是啥类型切",
 * 可"是啥类型"在前面),按切点在台词里的位置把第 2 个以后的镜头重新排 —— 切点就是"这个镜头讲的内容念到哪",
 * 按它排,画面才跟得上话。切点有找不到的就不动。
 */
export function orderByFrom(shots, text) {
  const index = estimatedIndex(text);
  const pos = fromPositions(shots, index);
  if (shots.length < 3 || pos.slice(1).some((p) => p.pos == null)) return { shots, changed: false };
  const rest = shots.slice(1).map((s, k) => ({ s, p: pos[k + 1].pos, k })).sort((a, b) => a.p - b.p || a.k - b.k);
  const changed = rest.some((x, k) => x.k !== k);
  return { shots: changed ? [shots[0], ...rest.map((x) => x.s)] : shots, changed };
}

export function timeShots(shots, index, beatDur, segDur = beatDur, fps = FPS) {
  const notes = [];
  const n = shots.length;
  // 切点:找每个镜头的 from 在台词里的位置,取"按镜头顺序递增"的那组里对上最多、离均分位置最近的,
  // 顺序不对的切点不采用(按均分放)—— 以前是按顺序往后找,前面一个切点落得太晚,后面全部挤在尾巴上
  const pos = fromPositions(shots, index);
  const total = Math.max(1, index.text ? [...index.text].length : 1);
  let best = { mask: 0, score: -Infinity };
  for (let mask = 0; mask < 1 << Math.max(0, n - 1); mask++) {
    let last = -1;
    let ok = true;
    let score = 0;
    for (let i = 1; i < n; i++) {
      if (!(mask & (1 << (i - 1)))) continue;
      const p = pos[i].pos;
      if (p == null || p <= last) {
        ok = false;
        break;
      }
      last = p;
      score += 10 - Math.abs(p / total - i / n) * 4;
    }
    if (ok && score > best.score) best = { mask, score };
  }
  const starts = [0];
  const used = [true];
  for (let i = 1; i < n; i++) {
    const use = best.mask & (1 << (i - 1));
    used.push(!!(use && pos[i].hit));
    const hit = pos[i].hit;
    if (use && hit) {
      starts.push(Math.max(0, hit.t - 0.12));
      if (!hit.whole) notes.push(`第 ${i + 1} 个镜头的切点「${shots[i].from}」只对上了「${hit.matched}」`);
    } else {
      starts.push(null);
      if (shots[i].from) notes.push(hit ? `第 ${i + 1} 个镜头的切点「${shots[i].from}」和前后顺序对不上,按均分放` : `第 ${i + 1} 个镜头的切点「${shots[i].from}」在台词里找不到,按均分放`);
    }
  }
  // 没对上的切点:在前后已知切点之间均分
  for (let i = 1; i < n; i++) {
    if (starts[i] != null) continue;
    let b = i + 1;
    while (b < n && starts[b] == null) b++;
    const ta = starts[i - 1];
    const tb = b < n ? starts[b] : beatDur;
    starts[i] = ta + (tb - ta) / (b - i + 1);
  }
  // 单调、每个镜头至少 MIN_SHOT 秒;放不下的镜头从尾巴上丢掉
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] < starts[i - 1] + MIN_SHOT) starts[i] = starts[i - 1] + MIN_SHOT;
  }
  while (starts.length > 1 && starts[starts.length - 1] > beatDur - MIN_SHOT * 0.8) {
    starts.pop();
    notes.push(`这拍太短,放不下第 ${starts.length + 1} 个镜头,去掉了`);
  }
  const spans = [];
  const totalFrames = Math.max(1, Math.round(segDur * fps));
  for (let i = 0; i < starts.length; i++) {
    const fromFrame = Math.round(starts[i] * fps);
    const endFrame = i + 1 < starts.length ? Math.round(starts[i + 1] * fps) : totalFrames;
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : segDur;
    const s = shots[i];
    const texts = s.tpl ? cueTexts(s.tpl, s.p) : [];
    // 镜头内元素:在这个镜头的时间段里找念到它的时刻;没找到的留空,模板自己均匀排
    const startChar = index.times.findIndex((t) => t >= start - 0.05);
    let c = Math.max(0, startChar < 0 ? index.times.length : startChar);
    const cues = [];
    const hits = [];
    for (const tx of texts) {
      const h = tx ? findSpoken(index, tx, c) : null;
      if (h && h.t < end) {
        cues.push(Math.max(2, Math.round((h.t - start - 0.15) * fps)));
        hits.push(h.matched);
        c = h.charIdx + 1;
      } else {
        cues.push(null);
        hits.push(null);
      }
    }
    // 切到这个镜头本身就是踩着台词的,第一个元素要立刻出来 —— 否则会空着画面等一两秒
    if (cues.length && cues[0] != null && cues[0] > 6) cues[0] = 4;
    // 对上的时刻要单调;没对上的夹在中间补齐(模板里 null 会走均分,但夹在两个已知时刻之间更准)
    fillCues(cues, endFrame - fromFrame);
    spans.push({ i, start, end, fromFrame, frames: Math.max(1, endFrame - fromFrame), cues, hits, cut: i === 0 ? "start" : used[i] ? "spoken" : "even" });
  }
  return { spans, notes };
}

function fillCues(cues, frames) {
  const n = cues.length;
  if (!n || cues.every((c) => c == null)) {
    for (let i = 0; i < n; i++) cues[i] = null;
    return;
  }
  const last = Math.max(8, Math.round(frames * 0.8));
  for (let i = 0; i < n; i++) {
    if (cues[i] != null) continue;
    let a = i - 1;
    while (a >= 0 && cues[a] == null) a--;
    let b = i + 1;
    while (b < n && cues[b] == null) b++;
    const ta = a >= 0 ? cues[a] : 4;
    const tb = b < n ? cues[b] : last;
    cues[i] = Math.round(ta + ((tb - ta) * (i - a)) / (b - a));
  }
  let prev = 2;
  for (let i = 0; i < n; i++) {
    cues[i] = Math.min(last, Math.max(prev, cues[i]));
    prev = cues[i] + 8; // 相邻两项至少隔 8 帧
  }
}

/** 网页预览用:还没配音,按字数估每个镜头的时长和元素时刻 */
export function previewBeat(text, shots, gap = 0.3, fps = FPS) {
  const index = estimatedIndex(text);
  const beatDur = Math.max(1.5, index.dur + gap);
  const { spans } = timeShots(shots, index, beatDur, beatDur, fps);
  return { frames: Math.round(beatDur * fps), spans };
}
