// 产品页镜头的"导演":在录下来的整页长图上,按念到的时刻滚动、推近、划线、光标点击。
// 照 ops-bilibili 的手机敲黑板片(lingban-shadow-4angles):每个要点推到约 1.85 倍,
// 推镜在关键词前开始、划线和点击落在关键词念出的那一刻,两个要点离得远就先拉回全景再滚过去。
// 网页预览和渲染机共用,纯 JS。坐标:页面 CSS 像素;舞台(输出画面)像素。

const clean = (s) => [...String(s ?? "")].filter((ch) => !/[\p{P}\p{S}\s]/u.test(ch)).join("");

/** 在页面上找一段字:先找整段包含它的"叶子"(越短越具体越好),找不到就找最长的公共片段(≥2 字) */
export function findText(layout, query) {
  const q = clean(query);
  if (q.length < 1 || !layout?.leaves?.length) return null;
  let best = null;
  for (const L of layout.leaves) {
    const t = clean(L.t);
    const at = t.indexOf(q);
    if (at < 0) continue;
    const score = q.length / t.length - L.y / 1e7;
    if (!best || score > best.score) best = { L, i0: at, i1: at + q.length, score, whole: true };
  }
  if (!best && q.length >= 2) {
    for (const L of layout.leaves) {
      const t = clean(L.t);
      for (let n = q.length - 1; n >= 2; n--) {
        let hit = -1;
        let piece = "";
        for (let s = 0; s + n <= q.length && hit < 0; s++) {
          piece = q.slice(s, s + n);
          hit = t.indexOf(piece);
        }
        if (hit >= 0) {
          const score = n / q.length - 1 + n / t.length / 10;
          if (!best || score > best.score) best = { L, i0: hit, i1: hit + n, score, whole: false };
          break;
        }
      }
    }
  }
  if (!best) return null;
  const { L, i0, i1 } = best;
  // 这段字在哪几行、每行的哪一截(行内按字数线性估)
  const rects = [];
  for (const ln of L.lines?.length ? L.lines : [{ i0: 0, i1: clean(L.t).length, x: L.x, y: L.y, w: L.w, h: L.h }]) {
    const a = Math.max(i0, ln.i0);
    const b = Math.min(i1, ln.i1);
    if (b <= a) continue;
    const per = ln.w / Math.max(1, ln.i1 - ln.i0);
    rects.push({ x: ln.x + per * (a - ln.i0), y: ln.y, w: per * (b - a), h: ln.h });
  }
  if (!rects.length) rects.push({ x: L.x, y: L.y, w: L.w, h: L.h });
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { leaf: L, rects, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, card: { x: L.x, y: L.y, w: L.w, h: L.h }, whole: best.whole };
}

/** 手机样机在舞台上的位置:屏幕停在字幕带上面(竖屏字幕在 72% 处) */
export function phoneGeom(W, H, layout) {
  const portrait = H >= W;
  const top = Math.round(H * (portrait ? 0.07 : 0.08));
  const bottom = Math.round(H * (portrait ? 0.69 : 0.8));
  const screenH = bottom - top;
  const vpH = layout?.viewportH || 932;
  const cssW = layout?.cssW || 430;
  const screenW = Math.round((screenH * cssW) / vpH);
  const left = Math.round((W - screenW) / 2);
  return { left, top, screenW, screenH, s: screenW / cssW, vpH, bezel: Math.round(screenW * 0.026) };
}

/** 不带手机壳:页面铺满画面宽度 */
export function pageGeom(W, H, layout) {
  const cssW = layout?.cssW || 430;
  const s = W / cssW;
  return { left: 0, top: 0, screenW: W, screenH: H, s, vpH: H / s, bezel: 0 };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 排这个镜头的动作。frames = 镜头帧数;cues = 每个 focus 念到的帧(可能是 null → 均分)。
 * 返回 {targets:[{hit, at}], track: (f) => {scrollY, z, fx, fy}, taps:[{at, x, y}], marks:[{at, rects}]}
 */
export function planPage(layout, p, frames, cues, geom, stage) {
  const focus = (Array.isArray(p.focus) ? p.focus : [p.focus]).filter(Boolean).slice(0, 4);
  const hits = focus.map((q) => findText(layout, q));
  const n = focus.length;
  const targets = [];
  hits.forEach((hit, k) => {
    if (!hit) return;
    let at = Number.isFinite(cues?.[k]) ? cues[k] : null;
    if (at == null) at = Math.round(18 + ((frames * 0.72 - 18) * k) / Math.max(1, n - 1 || 1));
    targets.push({ hit, at: clamp(Math.round(at), 14, Math.max(14, frames - 10)) });
  });
  targets.sort((a, b) => a.at - b.at);
  // 每个要点至少要 40 帧(推近 21 帧 + 停住看清);镜头短就只留放得下的前几个,别一秒里又滚又推
  targets.splice(Math.max(1, Math.floor(frames / 40)));
  const vp = geom.vpH;
  const maxScroll = Math.max(0, (layout?.cssH || vp) - vp);
  const Z = p.mode === "page" ? 1.55 : 1.85;
  // 关键帧:{f, scrollY, z, tx, ty}(tx/ty 是页面坐标里要放到画面焦点位置的点;null = 屏幕中心)
  // 开场就停在第一个要点上面一点(切进来就是要讲的那段),只轻轻往下滚一小段再推近 ——
  // 从页面顶上一路滚到底部的要点,一两秒滚几千像素,看着像在甩
  const first = targets[0]?.hit;
  // 短镜头(不到 2.5 秒)不滚,切进来就在要点上,直接推
  const lead = frames < 75 ? 0 : vp * 0.3;
  const y0 = first ? clamp(first.box.y + first.box.h / 2 - vp * 0.38 - lead, 0, maxScroll) : 0;
  const keys = [{ f: 0, scrollY: y0, z: 1, tx: null, ty: null }];
  let cur = keys[0];
  const put = (k) => {
    k.f = Math.max(Math.round(k.f), cur.f + 1);
    keys.push(k);
    cur = k;
  };
  for (const { hit, at } of targets) {
    const cx = hit.box.x + hit.box.w / 2;
    const cy = hit.box.y + hit.box.h / 2;
    const want = clamp(cy - vp * 0.38, 0, maxScroll);
    const dist = Math.abs(want - cur.scrollY);
    const zoomed = cur.z > 1.01;
    if (zoomed && dist <= 120) {
      // 离得近:推着直接平移过去
      put({ ...cur, f: at - 12 });
      put({ f: at + 9, scrollY: want, z: Z, tx: cx, ty: cy });
      continue;
    }
    // 离得远(或者还没推近):拉回全景 → 滚到位 → 推近,推近在关键词前 10 帧开始、21 帧到位
    // 滚动时长按距离:近的 0.8 秒,越远越长,最多 1.5 秒(一下滚几千像素太快就成了甩)
    const sd = Math.round(clamp(24 + dist / 150, 24, 45));
    let f = at - 12 - (dist > 2 ? sd + 2 : 0) - (zoomed ? 13 : 0);
    put({ ...cur, f });
    if (zoomed) {
      put({ f: f + 12, scrollY: cur.scrollY, z: 1, tx: null, ty: null });
      f += 13;
    }
    if (dist > 2) {
      put({ f: f + sd, scrollY: want, z: 1, tx: null, ty: null });
      f += sd + 2;
    }
    put({ ...cur, f: at - 10 });
    put({ f: at + 11, scrollY: want, z: Z, tx: cx, ty: cy });
  }
  // 最后一个要点推到位后如果还要停很久(念完这句还有两三秒),继续极慢地推一点,别停成死帧
  if (targets.length && keys[keys.length - 1].f < frames - 30) put({ ...cur, f: frames, z: cur.z * 1.05 });
  // 开场如果要停着等(要点已经在屏幕上、不用滚),就慢慢推一点点,别有死帧
  if (keys.length > 2 && keys[1].f > 8 && keys[1].z === 1 && Math.abs(keys[1].scrollY - keys[0].scrollY) < 2) keys[1] = { ...keys[1], z: 1.05 };
  const taps = [];
  const marks = [];
  for (const t of targets) {
    marks.push({ at: t.at, rects: t.hit.rects });
    const r = t.hit.rects[0];
    if (p.mode !== "page") {
      taps.push({ at: t.at, x: r.x + Math.min(r.w, 40) * 0.5, y: r.y + r.h / 2 });
      taps.push({ at: t.at + 8, x: r.x + Math.min(r.w, 40) * 0.5, y: r.y + r.h / 2 });
    }
  }
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const track = (f) => {
    let a = keys[0];
    let b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (f >= keys[i].f && f <= keys[i + 1].f) {
        a = keys[i];
        b = keys[i + 1];
        break;
      }
      if (f > keys[i + 1].f) a = b = keys[i + 1];
    }
    const t = a === b || b.f === a.f ? 1 : ease(clamp((f - a.f) / (b.f - a.f), 0, 1));
    const lerp = (x, y) => x + (y - x) * t;
    const scrollY = lerp(a.scrollY, b.scrollY);
    const z = lerp(a.z, b.z);
    // 焦点:没指定就是屏幕中心
    const center = (k) => (k.tx == null ? { x: (layout?.cssW || 430) / 2, y: k.scrollY + vp * 0.5 } : { x: k.tx, y: k.ty });
    const ca = center(a);
    const cb = center(b);
    return { scrollY, z, fx: lerp(ca.x, cb.x), fy: lerp(ca.y, cb.y) };
  };
  void stage;
  return { targets, track, taps, marks, missing: focus.filter((_, k) => !hits[k]) };
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * 给排镜头的 LLM 看的页面文字清单:按分区列,每段字原样(focus 必须从这里抄)。
 * 太长的页面只留每个分区的前几段,总长约 2400 字以内。
 */
export function pageDigest(doc, budget = 2400) {
  const secs = [...(doc.sections || [])].sort((a, b) => a.y - b.y);
  // 第一个分区标题之前的(页首大标题、结论)单独一组
  const groups = [{ title: secs.length ? "页首" : "整页", y: -1e9, items: [] }, ...secs.map((s) => ({ title: s.title, y: s.y, items: [] }))];
  const seen = new Set();
  for (const L of [...(doc.leaves || [])].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const t = squash(L.t);
    if (t.length < 2 || seen.has(t) || /^[\d\s.%:/+-]+$/.test(t) && t.length < 3) continue;
    if (secs.some((s) => s.title === t)) continue;
    seen.add(t);
    let g = groups[0];
    for (const x of groups) if (x.y <= L.y + 4) g = x;
    g.items.push(t.length > 40 ? `${t.slice(0, 40)}…` : t);
  }
  const per = Math.max(4, Math.floor(budget / Math.max(1, groups.length) / 14));
  return groups
    .filter((g) => g.items.length)
    .map((g) => `  【${g.title}】${g.items.slice(0, per).join(" / ")}${g.items.length > per ? ` …(还有 ${g.items.length - per} 段)` : ""}`)
    .join("\n");
}
