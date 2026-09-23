// HTML 卡 → PNG (Playwright)。三套主题:dark(暗色编辑风,数据/严肃)/
// paper(暖纸感,情感/温暖内容)/ gradient(活力渐变,钩子/活泼)。
// 内容保持在底部 ~17% 字幕安全区以上。
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/macmini003/ops-bilibili/node_modules/playwright");

// 手绘图解用的手写体(手札体):macOS 的按需下载字体 Chromium 看不到,由 worker/py/extract_fonts.py
// 从系统字体包里抽成单个文件放在 worker/fonts/,渲染时拦截一个假地址把文件喂给页面。
export const HAND_FONT = join(dirname(fileURLToPath(import.meta.url)), "fonts", "HannotateSC-W7.otf");
const HAND_FONT_URL = "https://rf-fonts.local/hand.otf";

export function sizeFor(aspect) {
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "3:4") return { width: 1080, height: 1440 };
  return { width: 1080, height: 1920 }; // 9:16
}

const THEMES = {
  dark: {
    bg: "radial-gradient(120% 90% at 70% 15%, #1c1a17 0%, #121110 55%, #0b0a09 100%)",
    text: "#f5f1e9",
    bigText: "background:linear-gradient(160deg,#fff8ea 30%,#e8b64c 130%);-webkit-background-clip:text;background-clip:text;color:transparent;",
    accent: "#e8b64c",
    accentBorder: "rgba(232,182,76,.45)",
    subText: "rgba(245,241,233,.82)",
    footText: "rgba(245,241,233,.38)",
    grid: "rgba(245,241,233,.03)",
    nodeBg: "rgba(245,241,233,.06)",
    nodeBorder: "rgba(245,241,233,.22)",
    accentBg: "rgba(232,182,76,.10)",
    accentText: "#121110",
    vsColor: "rgba(245,241,233,.35)",
    rowBorder: "rgba(245,241,233,.12)",
    qmark: "rgba(232,182,76,.5)",
  },
  paper: {
    bg: "radial-gradient(120% 90% at 70% 12%, #fdfaf3 0%, #faf5ea 60%, #f4ecdc 100%)",
    text: "#221b12",
    bigText: "background:linear-gradient(160deg,#221b12 40%,#b3410f 135%);-webkit-background-clip:text;background-clip:text;color:transparent;",
    accent: "#b3410f",
    accentBorder: "rgba(179,65,15,.40)",
    subText: "rgba(34,27,18,.78)",
    footText: "rgba(34,27,18,.42)",
    grid: "rgba(34,27,18,.045)",
    nodeBg: "rgba(179,65,15,.05)",
    nodeBorder: "rgba(34,27,18,.20)",
    accentBg: "rgba(179,65,15,.09)",
    accentText: "#faf5ea",
    vsColor: "rgba(34,27,18,.35)",
    rowBorder: "rgba(34,27,18,.12)",
    qmark: "rgba(179,65,15,.4)",
  },
  gradient: {
    bg: "linear-gradient(155deg, #6d28d9 0%, #db2777 55%, #f59e0b 130%)",
    text: "#ffffff",
    bigText: "color:#ffffff;text-shadow:0 12px 44px rgba(0,0,0,.28);",
    accent: "#ffffff",
    accentBorder: "rgba(255,255,255,.55)",
    subText: "rgba(255,255,255,.92)",
    footText: "rgba(255,255,255,.6)",
    grid: "rgba(255,255,255,.06)",
    nodeBg: "rgba(255,255,255,.14)",
    nodeBorder: "rgba(255,255,255,.4)",
    accentBg: "rgba(255,255,255,.18)",
    accentText: "#6d28d9",
    vsColor: "rgba(255,255,255,.5)",
    rowBorder: "rgba(255,255,255,.2)",
    qmark: "rgba(255,255,255,.45)",
  },
  // 手绘图解(学 MuseDock 的「白底手写图解」):纯白纸、手写体、黑线条,红字标关系,橙字只给结论。
  // 纸面必须是纯 #FFFFFF、不能有渐变/阴影/网格 —— 落墨程序把"不是近白"的像素都当成笔迹。
  sketch: {
    bg: "#FFFFFF",
    text: "#1d1d1f",
    bigText: "color:#1d1d1f;",
    accent: "#d23c35",
    accentBorder: "#1d1d1f",
    subText: "#e8750a",
    footText: "#555555",
    grid: "transparent",
    nodeBg: "transparent",
    nodeBorder: "#1d1d1f",
    accentBg: "transparent",
    accentText: "#FFFFFF",
    vsColor: "#2b63c9",
    rowBorder: "#1d1d1f",
    qmark: "#d23c35",
  },
};

export function cardHTML(
  { kicker = "", big = "", sub = "", foot = "", type = "text", big2 = "", step_no = "", nodes = [], cols = [], rows = [], steps = [], theme = "dark" },
  { width, height },
  { animate = false, reveal = null, sketch = false } = {},
) {
  if (sketch) theme = "sketch";
  const T = THEMES[theme] || THEMES.dark;
  // reveal:每一项什么时候出现(秒),由 reveal.mjs 按念到的时间算;没给就用原来的固定节奏
  const R = reveal?.items || {};
  const at = (key, fallback) => (reveal && R[key] != null ? R[key] : fallback);
  const delay = (sec) => `animation-delay:${Number(sec).toFixed(2)}s;`;
  const vertical = height > width;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const bigSize = type === "data"
    ? (vertical ? 300 : 220)
    : Math.max(90, Math.min(vertical ? 190 : 150, Math.round((vertical ? 900 : 1500) / Math.max(1, String(big).length) * 1.6)));

  // 一个序号 → 一道数值斜坡(shotcraft: ui-entrance/value-stagger-gradient)。
  // 头一个走得远、糊得狠,越往后越轻,于是整组读成"一道波扫过去"而不是"逐个弹出"。
  const stagger = (i, n) => {
    const k = n > 1 ? i / (n - 1) : 0;
    const d = Math.round(46 - k * 32); // 位移 46px → 14px
    const b = (8 - k * 6).toFixed(1);  // 模糊 8px → 2px
    return `--rf-d:${d}px;--rf-b:${b}px`;
  };

  let center;
  if (type === "diagram") {
    center = `
      <div class="diagram">
        ${nodes.map((n, i) => `
          <div class="node a-node ${n.tone === "accent" ? "node-accent" : ""}" data-rk="node${i}" style="${delay(at(`node${i}`, 0.15 + i * 0.28))}${stagger(i, nodes.length)}">
            <div class="node-label">${esc(n.label)}</div>
            ${n.sub ? `<div class="node-sub">${esc(n.sub)}</div>` : ""}
          </div>
          ${i < nodes.length - 1 ? `<div class="edge a-edge" data-rk="edge${i}" style="${delay(reveal ? Math.max(0, at(`node${i + 1}`, 0) - 0.15) : 0.35 + i * 0.28)}"><div class="edge-arrow">→</div>${n.nextLabel ? `<div class="edge-label">${esc(n.nextLabel)}</div>` : ""}</div>` : ""}
        `).join("")}
      </div>
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  } else if (type === "table") {
    center = `
      ${big ? `<div class="big" data-rk="title" style="font-size:${Math.round(bigSize * 0.6)}px;margin-bottom:${vertical ? 44 : 32}px">${esc(big)}</div>` : ""}
      <table class="ktable">
        <thead data-rk="thead"><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-rk="row${i}" ${reveal ? `style="${delay(at(`row${i}`, 0.55 + i * 0.2))}"` : ""}>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      ${sub ? `<div class="sub ${reveal ? "a-sub" : ""}" data-rk="sub" style="font-size:${vertical ? 40 : 34}px;${reveal?.sub != null ? delay(reveal.sub) : ""}">${esc(sub)}</div>` : ""}`;
  } else if (type === "flow") {
    center = `
      ${big ? `<div class="big" data-rk="title" style="font-size:${Math.round(bigSize * 0.6)}px;margin-bottom:${vertical ? 48 : 36}px">${esc(big)}</div>` : ""}
      <div class="flow">
        ${steps.map((st, i) => `
          <div class="fstep a-step" data-rk="step${i}" style="${delay(at(`step${i}`, 0.15 + i * 0.25))}${stagger(i, steps.length)}">
            <div class="fstep-no">${i + 1}</div>
            <div class="fstep-label">${esc(st.label)}</div>
            ${st.sub ? `<div class="fstep-sub">${esc(st.sub)}</div>` : ""}
          </div>
          ${i < steps.length - 1 ? `<div class="farrow a-edge" data-rk="arrow${i}" style="${delay(reveal ? Math.max(0, at(`step${i + 1}`, 0) - 0.15) : 0.3 + i * 0.25)}">→</div>` : ""}
        `).join("")}
      </div>
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  } else if (type === "contrast") {
    const sideFont = (t) => {
      const len = Math.max(1, String(t).length);
      return Math.max(vertical ? 48 : 42, Math.min(vertical ? 110 : 88, Math.round((vertical ? 380 : 560) / len)));
    };
    center = `
      <div class="versus">
        <div class="side a-side-l" data-rk="sideL" ${reveal ? `style="${delay(at("sideL", 0.25))}"` : ""}><div class="side-big" style="font-size:${sideFont(big)}px">${esc(big)}</div></div>
        <div class="vs a-vs" data-rk="vs" ${reveal ? `style="${delay(Math.max(0, at("sideR", 0.95) - 0.3))}"` : ""}>VS</div>
        <div class="side alt a-side-r" data-rk="sideR" ${reveal ? `style="${delay(at("sideR", 0.55))}"` : ""}><div class="side-big" style="font-size:${sideFont(big2)}px">${esc(big2)}</div></div>
      </div>
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  } else if (type === "step") {
    center = `
      ${step_no ? `<div class="stepno a-big" data-rk="stepno">${esc(step_no)}</div>` : ""}
      <div class="big" data-rk="title">${esc(big)}</div>
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  } else if (type === "quote") {
    center = `
      <div class="qmark a-q" data-rk="qmark">"</div>
      <div class="big quote a-big" data-big data-rk="title">${esc(big)}</div>
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  } else {
    center = `
      <div class="big a-big ${type === "data" ? "data" : ""}" data-big data-rk="title">${esc(big)}</div>
      ${type === "data" ? `<div class="bar a-bar" data-rk="bar"></div>` : ""}
      ${sub ? `<div class="sub a-sub" data-rk="sub" ${reveal?.sub != null ? `style="${delay(reveal.sub)}"` : ""}>${esc(sub)}</div>` : ""}`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body {
  background: ${T.bg};
  color: ${T.text}; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  position: relative;
}
body::before {
  content: ""; position: absolute; inset: 0;
  background-image: linear-gradient(${T.grid} 1px, transparent 1px),
                    linear-gradient(90deg, ${T.grid} 1px, transparent 1px);
  background-size: ${vertical ? "108px 108px" : "160px 160px"};
  mask-image: radial-gradient(80% 70% at 50% 40%, black 30%, transparent 100%);
}
.wrap { position: relative; text-align: center; padding: 0 ${vertical ? 70 : 160}px; max-height: ${Math.round(height * 0.72)}px; width: 100%; }
.kicker {
  display: inline-block; font-size: ${vertical ? 34 : 30}px; letter-spacing: .35em;
  color: ${T.accent}; border: 1px solid ${T.accentBorder}; border-radius: 999px;
  padding: ${vertical ? "10px 30px 10px 38px" : "8px 24px 8px 32px"}; margin-bottom: ${vertical ? 60 : 40}px;
  ${theme === "gradient" ? "background:rgba(255,255,255,.16);" : ""}
}
.big {
  font-weight: 800; font-size: ${bigSize}px; line-height: 1.12; letter-spacing: .02em;
  ${T.bigText}
  text-wrap: balance;
}
.big.quote { font-size: ${Math.round(bigSize * 0.9)}px; line-height: 1.3; }
.qmark { font-size: ${vertical ? 200 : 160}px; line-height: .6; color: ${T.qmark}; font-family: Georgia, serif; margin-bottom: ${vertical ? 30 : 20}px; }
.sub { margin-top: ${vertical ? 46 : 34}px; font-size: ${vertical ? 46 : 40}px; line-height: 1.5; color: ${T.subText}; font-weight: 500; }
.foot { position: absolute; left: 0; right: 0; bottom: ${Math.round(height * 0.2)}px; text-align: center; font-size: ${vertical ? 28 : 24}px; color: ${T.footText}; letter-spacing: .1em; }
.bar { width: ${vertical ? 96 : 80}px; height: 6px; border-radius: 3px; background: ${T.accent}; margin: ${vertical ? "54px" : "40px"} auto 0; }
.versus { display: flex; align-items: center; justify-content: center; gap: ${vertical ? 40 : 48}px; }
.side { flex: 1; max-width: 44%; min-width: 0; overflow-wrap: anywhere; }
.side-big { font-weight: 800; line-height: 1.2; color: ${T.text}; text-wrap: balance; }
.side.alt .side-big { color: ${T.accent}; }
.vs { font-size: ${vertical ? 44 : 40}px; font-weight: 800; color: ${T.vsColor}; letter-spacing: .1em; }
.stepno {
  font-size: ${vertical ? 260 : 200}px; font-weight: 900; line-height: 1; color: transparent;
  -webkit-text-stroke: 3px ${T.accent}; margin-bottom: ${vertical ? 24 : 16}px;
}
/* 关系图 */
.diagram { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: ${vertical ? 28 : 24}px; }
.node {
  background: ${T.nodeBg}; border: 2px solid ${T.nodeBorder}; border-radius: ${vertical ? 24 : 20}px;
  padding: ${vertical ? "36px 44px" : "28px 36px"}; text-align: center; min-width: ${vertical ? 220 : 180}px;
}
.node-accent { border-color: ${T.accent}; background: ${T.accentBg}; }
.node-label { font-size: ${vertical ? 56 : 48}px; font-weight: 800; color: ${T.text}; }
.node-sub { margin-top: 10px; font-size: ${vertical ? 30 : 26}px; color: ${T.footText}; }
.edge { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.edge-arrow { font-size: ${vertical ? 64 : 56}px; color: ${T.accent}; font-weight: 700; line-height: 1; }
.edge-label { font-size: ${vertical ? 34 : 30}px; font-weight: 700; color: ${T.accent}; }
/* 对照表 */
.ktable { border-collapse: collapse; width: 100%; background: ${T.nodeBg}; border-radius: 16px; overflow: hidden; }
.ktable th {
  font-size: ${vertical ? 34 : 30}px; font-weight: 700; color: ${T.accent}; text-align: left;
  padding: ${vertical ? "22px 30px" : "18px 24px"}; border-bottom: 2px solid ${T.accentBorder};
}
.ktable td {
  font-size: ${vertical ? 36 : 32}px; color: ${T.text}; text-align: left;
  padding: ${vertical ? "22px 30px" : "18px 24px"}; border-bottom: 1px solid ${T.rowBorder}; line-height: 1.4;
}
.ktable tr:last-child td { border-bottom: none; }
/* 步骤链 */
.flow { display: flex; align-items: stretch; justify-content: center; gap: ${vertical ? 20 : 16}px; flex-wrap: wrap; }
.fstep {
  background: ${T.nodeBg}; border: 1px solid ${T.nodeBorder}; border-radius: 20px;
  padding: ${vertical ? "28px 26px" : "22px 20px"}; text-align: center; min-width: ${vertical ? 200 : 170}px; max-width: ${vertical ? 260 : 220}px;
}
.fstep-no {
  width: ${vertical ? 56 : 48}px; height: ${vertical ? 56 : 48}px; margin: 0 auto ${vertical ? 16 : 12}px;
  border-radius: 999px; background: ${T.accent}; color: ${T.accentText};
  font-size: ${vertical ? 34 : 30}px; font-weight: 800; line-height: ${vertical ? 56 : 48}px;
}
.fstep-label { font-size: ${vertical ? 38 : 32}px; font-weight: 700; color: ${T.text}; line-height: 1.3; }
.fstep-sub { margin-top: 8px; font-size: ${vertical ? 27 : 24}px; color: ${T.footText}; line-height: 1.4; }
.farrow { align-self: center; font-size: ${vertical ? 44 : 40}px; color: ${T.accent}; font-weight: 700; }
${theme === "sketch" ? `
@font-face { font-family: "RFHand"; src: url("${HAND_FONT_URL}") format("opentype"); font-display: block; }
body { font-family: "RFHand", "Kaiti SC", "PingFang SC", sans-serif; }
body::before { display: none; }
.big, .side-big, .node-label, .fstep-label { font-weight: 700; letter-spacing: .04em; }
.kicker { border: 3px solid #1d1d1f; color: #1d1d1f; border-radius: 26px 18px 24px 16px / 16px 24px 18px 26px; }
.node { border-width: 4px; border-radius: 34px 22px 30px 18px / 20px 32px 18px 28px; }
.node-accent { border-color: #d23c35; }
.node-sub, .fstep-sub { color: #2b63c9; }
.edge-arrow, .farrow { font-family: "RFHand", sans-serif; font-size: ${vertical ? 88 : 72}px; }
.fstep { border-width: 3px; border-radius: 28px 18px 26px 16px / 18px 26px 16px 28px; }
.fstep-no { background: transparent; color: #d23c35; border: 3px solid #d23c35; }
.ktable { background: transparent; border: none; }
.ktable th { color: #d23c35; border-bottom: 4px solid #1d1d1f; }
.ktable td { border-bottom: 2px solid #1d1d1f; }
.sub { font-weight: 700; }
.bar { background: #d23c35; }
` : ""}
${animate ? `
/* ── 入场动画(hyperframes 式:布局先行,动画只负责"怎么进来";入场完静止) ── */
@keyframes rf-fade-down { from { opacity:0; transform:translateY(-24px);} to {opacity:1; transform:none;} }
@keyframes rf-pop { 0% {opacity:0; transform:scale(.86);} 55% {opacity:1; transform:scale(1.05);} 100% {opacity:1; transform:scale(1);} }
@keyframes rf-rise { from {opacity:0; transform:translateY(30px);} to {opacity:1; transform:none;} }
/* blur-slide(shotcraft typography/blur-slide):带景深的滑入,比纯位移"贵"很多 */
@keyframes rf-blur-slide { from {opacity:0; transform:translateY(22px); filter:blur(14px);} to {opacity:1; transform:none; filter:blur(0);} }
/* 数值梯度版的入场:位移和模糊都读元素自己的 --rf-d / --rf-b */
@keyframes rf-rise-v {
  from { opacity:0; transform:translateY(var(--rf-d,30px)); filter:blur(var(--rf-b,0px)); }
  to   { opacity:1; transform:none; filter:blur(0); }
}
/* gradient-word-sweep(shotcraft typography):一道亮波从左扫过大字"充能",
   扫完回稳态。要点是快(约 0.6s)且波前最亮——慢了就读成进度条。 */
@keyframes rf-sweep { from { background-position: -140% 0; } to { background-position: 140% 0; } }
@keyframes rf-draw { from {opacity:0; transform:scaleX(0);} to {opacity:1; transform:scaleX(1);} }
@keyframes rf-slide-l { from {opacity:0; transform:translateX(-64px);} to {opacity:1; transform:none;} }
@keyframes rf-slide-r { from {opacity:0; transform:translateX(64px);} to {opacity:1; transform:none;} }
.a-kicker { animation: rf-blur-slide .5s .1s both; }
.a-big { animation: rf-pop .65s .35s both; }
/* 大字扫光:.bigText 本来就是 background-clip:text 的渐变,把背景拉宽再推一遍
   位置,亮波就从字里走过去了(纯色主题没有渐变,这条自然不生效)。 */
.big.a-big { background-size: 260% 100%; animation: rf-pop .65s .35s both, rf-sweep .6s 1.0s both; }
.a-q { animation: rf-pop .5s .15s both; }
.a-bar { animation: rf-draw .5s .95s both; transform-origin:center; }
.a-sub { animation: rf-blur-slide .62s 1.05s both; }
.a-side-l { animation: rf-slide-l .55s .25s both; }
.a-side-r { animation: rf-slide-r .55s .55s both; }
.a-vs { animation: rf-pop .4s .95s both; }
.a-node { animation: rf-rise-v .55s both; }
.a-step { animation: rf-rise-v .5s both; }
.a-edge { animation: rf-draw .4s both; transform-origin:center; }
.ktable tbody tr { animation: rf-rise .4s both; }
.ktable tbody tr:nth-child(1) { animation-delay:.55s } .ktable tbody tr:nth-child(2) { animation-delay:.75s }
.ktable tbody tr:nth-child(3) { animation-delay:.95s } .ktable tbody tr:nth-child(4) { animation-delay:1.15s }
.ktable thead tr { animation: rf-fade-down .4s .3s both; }
${reveal ? `.a-sub { animation-duration: .5s; } .ktable tbody tr { animation-duration: .45s; }` : ""}
` : ""}
</style>
${animate && type === "data" ? `<script>
addEventListener('load', () => {
  const el = document.querySelector('[data-big]');
  if (!el) return;
  const orig = el.textContent;
  const m = orig.match(/^([^\d]*)([\d.]+)([\s\S]*)$/);
  if (!m) return;
  const target = parseFloat(m[2]); const dec = (m[2].split('.')[1] || '').length;
  const t0 = performance.now() + 400;
  (function tick() {
    const p = Math.min(1, Math.max(0, (performance.now() - t0) / 900));
    const v = target * (1 - Math.pow(1 - p, 3));
    el.textContent = m[1] + v.toFixed(dec) + m[3];
    if (p < 1) requestAnimationFrame(tick);
  })();
});
</script>` : ""}
</head><body>
<div class="wrap">
  ${kicker ? `<div class="kicker a-kicker" data-rk="kicker">${esc(kicker)}</div>` : ""}
  ${center}
</div>
${foot ? `<div class="foot">${esc(foot)}</div>` : ""}
</body></html>`;
}

let browserPromise = null;
async function browser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

export async function renderCard(content, size, outPath) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath.replace(/\.png$/, ".html"), cardHTML(content, size));
  const b = await browser();
  const ctx = await b.newContext({ viewport: size, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.setContent(cardHTML(content, size), { waitUntil: "load" });
  const layout = await inspectLayout(page, size);
  await page.screenshot({ path: outPath });
  await ctx.close();
  return { path: outPath, layout };
}

// 排版毛病用尺子量,不要花钱问视觉模型 —— getBoundingClientRect 给的是准确答案,
// 模型给的是猜测。(学 MuseDock 的 layoutQaService,只是它跑在整条时间轴上。)
// 视觉模型仍然要跑,但让它只管"好不好看/信息够不够",不管"有没有溢出"。
async function inspectLayout(page, { width, height }) {
  const safeBottom = Math.round(height * 0.17); // 底部字幕安全区
  return page.evaluate(({ w, h, safeBottom }) => {
    const issues = [];
    const seen = new Set();
    const add = (msg) => { if (!seen.has(msg)) { seen.add(msg); issues.push(msg); } };
    const label = (el) => (el.className && typeof el.className === "string" ? el.className.split(" ")[0] : el.tagName.toLowerCase());
    const text = (el) => (el.textContent || "").trim().slice(0, 18);

    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

      if (r.right > w + 1 || r.left < -1) add(`「${text(el)}」横向出画(${label(el)})`);
      if (r.bottom > h + 1 || r.top < -1) add(`「${text(el)}」纵向出画(${label(el)})`);
      // 文字被容器裁掉(溢出但没滚动条,截图里就是缺字)
      if (hasOwnText && style.overflow !== "visible") {
        if (el.scrollWidth > el.clientWidth + 2) add(`「${text(el)}」被容器裁掉一截(${label(el)})`);
        if (el.scrollHeight > el.clientHeight + 2) add(`「${text(el)}」下半截被裁(${label(el)})`);
      }
      // 正文压进底部字幕安全区(.foot 是设计上就放在那儿的,放过)
      if (hasOwnText && !el.closest(".foot") && r.bottom > h - safeBottom) {
        add(`「${text(el)}」压到底部字幕区了(${label(el)})`);
      }
    }
    return issues.slice(0, 6);
  }, { w: width, h: height, safeBottom });
}

// 动画卡:Playwright recordVideo 实时录 webm(入场动画在头 ~1.5s,之后静止,
// 剪辑时按拍长裁剪/循环尾巴即可)。durSec 建议 10-12s。
export async function renderCardVideo(content, size, durSec, outPath, { reveal = null } = {}) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const b = await browser();
  const tmp = join(outPath, "..", `rec-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const ctx = await b.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    recordVideo: { dir: tmp, size },
  });
  const page = await ctx.newPage();
  await page.setContent(cardHTML(content, size, { animate: true, reveal }), { waitUntil: "load" });
  await page.waitForTimeout(Math.round(durSec * 1000));
  await page.close();
  const vids = require("node:fs").readdirSync(tmp).filter((n) => n.endsWith(".webm"));
  await ctx.close();
  if (!vids.length) throw new Error("recordVideo produced no webm");
  require("node:fs").renameSync(join(tmp, vids[0]), outPath);
  require("node:fs").rmdirSync(tmp);
  return outPath;
}

// 手绘图解的底图:把同一张卡用手绘风格渲成静态 PNG,顺便量出每一项的位置 ——
// 这些框就是落墨程序的"分区",按 order 的顺序一块一块画出来(不用生图模型,字一定对)。
export async function renderSketchCard(content, size, outPath, order = []) {
  mkdirSync(join(outPath, ".."), { recursive: true });
  const b = await browser();
  const ctx = await b.newContext({ viewport: size, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await ctx.newPage();
  if (!existsSync(HAND_FONT)) throw new Error("手写体没准备好:在 worker 目录跑一次 worker/py/.venv/bin/python worker/py/extract_fonts.py");
  await page.route(HAND_FONT_URL, (route) => route.fulfill({ path: HAND_FONT, contentType: "font/otf" }));
  await page.setContent(cardHTML(content, size, { sketch: true }), { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.load('80px "RFHand"', "命");
    await document.fonts.ready;
  });
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-rk]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.rk, x: r.left, y: r.top, width: r.width, height: r.height };
    }),
  );
  await page.screenshot({ path: outPath });
  await ctx.close();
  const pad = 10;
  const byKey = new Map(boxes.filter((bx) => bx.width > 1 && bx.height > 1).map((bx) => [bx.key, bx]));
  const keys = [...order.filter((k) => byKey.has(k)), ...[...byKey.keys()].filter((k) => !order.includes(k))];
  const regions = keys.map((k) => {
    const bx = byKey.get(k);
    const x = Math.max(0, Math.floor(bx.x - pad));
    const y = Math.max(0, Math.floor(bx.y - pad));
    return {
      key: k,
      x,
      y,
      width: Math.min(size.width - x, Math.ceil(bx.width + pad * 2)),
      height: Math.min(size.height - y, Math.ceil(bx.height + pad * 2)),
    };
  });
  return { path: outPath, regions };
}

// One subtitle line as a full-frame TRANSPARENT PNG (text near the bottom),
// for ffmpeg overlay — this machine's ffmpeg is built without libass/drawtext.
export async function renderSubLine(text, { width, height }, outPath, theme = "dark", highlight = null) {
  const escOf = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // 镜头正推到的那个词在字幕里高亮(学 MuseDock captionLayer:#FFD54A、加粗、放大 1.08)
  let esc = escOf(text);
  if (highlight && String(text).includes(highlight)) {
    const i = String(text).indexOf(highlight);
    esc = `${escOf(String(text).slice(0, i))}<span class="hl">${escOf(highlight)}</span>${escOf(String(text).slice(i + highlight.length))}`;
  }
  // 照 ops-bilibili 她定下的字幕(2026-09-05):香槟金 #F2D9A0 + 墨蓝描边 #080D14,不许红白;
  // 竖屏放在 y≈0.72(抖音底部 20% 被文案和按钮盖着,她否过 y=1660 太低),3:4 放在 0.79 往下,横屏 0.86
  void theme;
  const fontSize = Math.round(width * 0.054);
  const ratio = height / width;
  const centerY = Math.round(height * (ratio > 1.6 ? 0.72 : ratio > 1.1 ? 0.81 : 0.87));
  const top = Math.round(centerY - fontSize * 0.65);
  const strokeW = Math.max(3, Math.round(width * 0.0083));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; }
html, body { width: ${width}px; height: ${height}px; background: transparent; overflow: hidden; }
.line {
  position: absolute; left: 0; right: 0; top: ${top}px; text-align: center;
  font-family: "PingFang SC", "Heiti SC", "STHeiti", "Hiragino Sans GB", sans-serif; font-weight: 600;
  font-size: ${fontSize}px; line-height: 1.3; color: #F2D9A0; letter-spacing: ${Math.round(width / 1080)}px;
  -webkit-text-stroke: ${strokeW}px #080D14;
  paint-order: stroke fill;
  text-shadow: 0 ${Math.round(width * 0.0037)}px ${Math.round(width * 0.0167)}px rgba(0,0,0,.85);
}
.hl { color: #FFE8A8; font-weight: 800; display: inline-block; transform: scale(1.08); margin: 0 .06em; }
</style></head><body><div class="line">${esc}</div></body></html>`;
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: "zh-CN" });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: outPath, omitBackground: true });
  await ctx.close();
  return outPath;
}

export async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; await b.close(); browserPromise = null; }
}
