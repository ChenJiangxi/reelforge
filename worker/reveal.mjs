// 卡片分步出现:一拍超过 6 秒,卡上的内容不再在头一秒全部弹完然后静止十来秒,
// 而是念到哪一项、哪一项才出来(学 MuseDock visualPlanService 的 ≤7s 一个小节拍 /
// framePromptBuilder "超过 6 秒要 2-3 个子节拍")。它按字数均分时间;我们有 MiniMax 的
// 逐字时间戳,直接找"这一项的字第一次被念到"的时刻。
// 手绘图解(draw.mjs)和音效(sfx.mjs)也用这里算出来的时间。

const PUNCT = /[\p{P}\p{S}\s]/u;

/** 一拍的逐字时间 → 连续字串 + 每个字的开始时间(秒,相对这拍开头) */
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

const clean = (s) => [...String(s ?? "")].filter((ch) => !PUNCT.test(ch)).join("");

/**
 * label 第一次在 from 之后被念到的时刻。整段找不到就退而找它最长的一段子串(至少 2 个字),
 * 比如卡上写「伤官见官」、台词里念的是「伤官一旦见了官」,也能对上「伤官」。
 */
export function findSpoken(index, label, from = 0) {
  const want = clean(label);
  if (want.length < 2 || !index.text) return null;
  const chars = [...index.text];
  const hay = chars.join("");
  // index.text 是按字拼的,但 indexOf 返回的是 UTF-16 下标 —— 统一换算成"第几个字"
  const toCharIdx = (u16) => [...hay.slice(0, u16)].length;
  const fromU16 = [...hay].slice(0, from).join("").length;
  const w = [...want];
  for (let n = w.length; n >= 2; n--) {
    for (let s = 0; s + n <= w.length; s++) {
      const piece = w.slice(s, s + n).join("");
      const at = hay.indexOf(piece, fromU16);
      if (at >= 0) {
        const ci = toCharIdx(at);
        return { t: index.times[ci], charIdx: ci, matched: piece, whole: n === w.length };
      }
    }
  }
  return null;
}

/** 卡上按出现顺序排好的各项:{ key, label } */
function itemsOf(card) {
  const t = card.type || "text";
  if (t === "diagram") return (card.nodes || []).map((n, i) => ({ key: `node${i}`, label: n.label || "" }));
  if (t === "flow") return (card.steps || []).map((s, i) => ({ key: `step${i}`, label: s.label || "" }));
  if (t === "table") {
    return (card.rows || []).map((r, i) => {
      const cells = Array.isArray(r) ? r : [];
      // 先用第一格(通常是这一行讲的"是什么"),不行再用别的格
      return { key: `row${i}`, label: cells[0] || "", alt: cells.slice(1) };
    });
  }
  if (t === "contrast") return [{ key: "sideL", label: card.big || "" }, { key: "sideR", label: card.big2 || "" }];
  return [];
}

/**
 * 算每一项什么时候出现(秒,相对这一拍开头)。
 * 返回 { applied, delays: {kicker, big, sub, items: {key: t}}, cues: [{key,label,t,matched}] }
 * applied=false 表示这拍太短或没有可分步的内容,照原来的入场动画。
 */
export function planReveal(card, words, beatDur) {
  const items = itemsOf(card);
  const base = { kicker: 0.1, big: 0.35 };
  if (beatDur <= 6 || !card) return { applied: false, delays: base, cues: [] };
  const index = spokenIndex(words);
  const lastOk = Math.max(1.2, beatDur - 1.2); // 最后一项也要留 1.2 秒让人看清全貌再切
  const cues = [];
  let cursor = 0;
  for (const it of items) {
    let hit = findSpoken(index, it.label, cursor);
    for (const alt of it.alt || []) {
      if (hit) break;
      hit = findSpoken(index, alt, cursor);
    }
    if (hit) cursor = hit.charIdx + 1;
    cues.push({ key: it.key, label: it.label, t: hit ? Math.max(0, hit.t - 0.2) : null, matched: hit?.matched ?? null });
  }
  // sub 通常是这一拍的结论:念到了就那时出,没念到就排在最后一项之后
  const subHit = card.sub ? findSpoken(index, card.sub, cursor) : null;

  // 没对上的项:夹在前后已知时间之间均匀排开;头尾没锚点就从 0.6s 排到 lastOk
  const known = cues.map((c) => c.t);
  for (let i = 0; i < cues.length; i++) {
    if (known[i] != null) continue;
    let a = i - 1;
    while (a >= 0 && known[a] == null) a--;
    let b = i + 1;
    while (b < cues.length && known[b] == null) b++;
    const ta = a >= 0 ? known[a] : 0.3; // 左边没锚点:从 0.3s 开始排
    const tb = b < cues.length ? known[b] : lastOk;
    const span = b - a;
    cues[i].t = ta + ((tb - ta) * (i - a)) / span;
  }
  // 单调、间隔至少 0.35s、都在 lastOk 之前
  let prev = 0.3;
  for (const c of cues) {
    c.t = Math.min(lastOk, Math.max(prev, c.t));
    prev = c.t + 0.35;
  }
  const lastT = cues.length ? cues[cues.length - 1].t : 0.35;
  const sub = card.sub ? Math.min(lastOk, Math.max(lastT + 0.5, subHit ? subHit.t - 0.2 : lastT + 0.6)) : null;

  if (!cues.length && !card.sub) return { applied: false, delays: base, cues: [] };
  // 纯文字类卡(text/quote/data/step)只有 sub 能分步:念到结论那句才出来
  if (!cues.length && card.sub && !subHit) return { applied: false, delays: base, cues: [] };
  return {
    applied: true,
    delays: { ...base, sub, items: Object.fromEntries(cues.map((c) => [c.key, Number(c.t.toFixed(2))])) },
    cues: [...cues, ...(card.sub ? [{ key: "sub", label: card.sub, t: sub, matched: subHit?.matched ?? null }] : [])],
  };
}
