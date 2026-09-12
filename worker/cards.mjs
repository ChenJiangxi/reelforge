// HTML 大字卡 → PNG (Playwright). Dark editorial style, amber accent, huge type.
// Content stays above the subtitle safe zone (bottom ~17% is reserved for subs).
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/macmini003/ops-bilibili/node_modules/playwright");

export function sizeFor(aspect) {
  if (aspect === "16:9") return { width: 1920, height: 1080 };
  if (aspect === "3:4") return { width: 1080, height: 1440 };
  return { width: 1080, height: 1920 }; // 9:16
}

export function cardHTML({ kicker = "", big = "", sub = "", foot = "", type = "text", big2 = "", step_no = "", nodes = [], cols = [], rows = [], steps = [] }, { width, height }) {
  const vertical = height > width;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const bigSize = type === "data"
    ? (vertical ? 300 : 220)
    : Math.max(90, Math.min(vertical ? 190 : 150, Math.round((vertical ? 900 : 1500) / Math.max(1, String(big).length) * 1.6)));

  let center;
  if (type === "diagram") {
    // 关系图:节点链 + 带标签的箭头(A --克--> B)
    center = `
      ${kicker ? "" : ""}
      <div class="diagram">
        ${nodes.map((n, i) => `
          <div class="node ${n.tone === "accent" ? "node-accent" : ""}">
            <div class="node-label">${esc(n.label)}</div>
            ${n.sub ? `<div class="node-sub">${esc(n.sub)}</div>` : ""}
          </div>
          ${i < nodes.length - 1 ? `<div class="edge"><div class="edge-line"></div><div class="edge-arrow">→</div>${n.nextLabel ? `<div class="edge-label">${esc(n.nextLabel)}</div>` : ""}</div>` : ""}
        `).join("")}
      </div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  } else if (type === "table") {

    center = `
      ${big ? `<div class="big" style="font-size:${Math.round(bigSize * 0.6)}px;margin-bottom:${vertical ? 44 : 32}px">${esc(big)}</div>` : ""}
      <table class="ktable">
        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      ${sub ? `<div class="sub" style="font-size:${vertical ? 40 : 34}px">${esc(sub)}</div>` : ""}`;
  } else if (type === "flow") {

    center = `
      ${big ? `<div class="big" style="font-size:${Math.round(bigSize * 0.6)}px;margin-bottom:${vertical ? 48 : 36}px">${esc(big)}</div>` : ""}
      <div class="flow">
        ${steps.map((st, i) => `
          <div class="fstep">
            <div class="fstep-no">${i + 1}</div>
            <div class="fstep-label">${esc(st.label)}</div>
            ${st.sub ? `<div class="fstep-sub">${esc(st.sub)}</div>` : ""}
          </div>
          ${i < steps.length - 1 ? `<div class="farrow">→</div>` : ""}
        `).join("")}
      </div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  } else if (type === "contrast") {
    center = `
      <div class="versus">
        <div class="side"><div class="side-big">${esc(big)}</div></div>
        <div class="vs">VS</div>
        <div class="side alt"><div class="side-big">${esc(big2)}</div></div>
      </div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  } else if (type === "step") {
    center = `
      ${step_no ? `<div class="stepno">${esc(step_no)}</div>` : ""}
      <div class="big">${esc(big)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  } else if (type === "quote") {
    center = `
      <div class="qmark">"</div>
      <div class="big quote">${esc(big)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  } else {
    center = `
      <div class="big ${type === "data" ? "data" : ""}">${esc(big)}</div>
      ${type === "data" ? `<div class="bar"></div>` : ""}
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
body {
  background: radial-gradient(120% 90% at 70% 15%, #1c1a17 0%, #121110 55%, #0b0a09 100%);
  color: #f5f1e9; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  position: relative;
}
body::before {
  content: ""; position: absolute; inset: 0;
  background-image: linear-gradient(rgba(245,241,233,.03) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(245,241,233,.03) 1px, transparent 1px);
  background-size: ${vertical ? "108px 108px" : "160px 160px"};
  mask-image: radial-gradient(80% 70% at 50% 40%, black 30%, transparent 100%);
}
.wrap { position: relative; text-align: center; padding: 0 ${vertical ? 70 : 160}px; max-height: ${Math.round(height * 0.72)}px; width: 100%; }
.kicker {
  display: inline-block; font-size: ${vertical ? 34 : 30}px; letter-spacing: .35em;
  color: #e8b64c; border: 1px solid rgba(232,182,76,.45); border-radius: 999px;
  padding: ${vertical ? "10px 30px 10px 38px" : "8px 24px 8px 32px"}; margin-bottom: ${vertical ? 60 : 40}px;
}
.big {
  font-weight: 800; font-size: ${bigSize}px; line-height: 1.12; letter-spacing: .02em;
  background: linear-gradient(160deg, #fff8ea 30%, #e8b64c 130%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  text-wrap: balance;
}
.big.quote { font-size: ${Math.round(bigSize * 0.9)}px; line-height: 1.3; }
.qmark { font-size: ${vertical ? 200 : 160}px; line-height: .6; color: rgba(232,182,76,.5); font-family: Georgia, serif; margin-bottom: ${vertical ? 30 : 20}px; }
.sub { margin-top: ${vertical ? 46 : 34}px; font-size: ${vertical ? 46 : 40}px; line-height: 1.5; color: rgba(245,241,233,.82); font-weight: 500; }
.foot { position: absolute; left: 0; right: 0; bottom: ${Math.round(height * 0.2)}px; text-align: center; font-size: ${vertical ? 28 : 24}px; color: rgba(245,241,233,.38); letter-spacing: .1em; }
.bar { width: ${vertical ? 96 : 80}px; height: 6px; border-radius: 3px; background: #e8b64c; margin: ${vertical ? "54px" : "40px"} auto 0; }
.versus { display: flex; align-items: center; justify-content: center; gap: ${vertical ? 40 : 48}px; }
.side { flex: 1; max-width: 42%; }
.side-big { font-weight: 800; font-size: ${Math.round(bigSize * 0.55)}px; line-height: 1.2; color: rgba(245,241,233,.9); text-wrap: balance; }
.side.alt .side-big { color: #e8b64c; }
.vs { font-size: ${vertical ? 44 : 40}px; font-weight: 800; color: rgba(245,241,233,.35); letter-spacing: .1em; }
.stepno {
  font-size: ${vertical ? 260 : 200}px; font-weight: 900; line-height: 1; color: transparent;
  -webkit-text-stroke: 3px rgba(232,182,76,.65); margin-bottom: ${vertical ? 24 : 16}px;
}
/* 关系图 */
.diagram { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: ${vertical ? 28 : 24}px; }
.node {
  background: rgba(245,241,233,.06); border: 2px solid rgba(245,241,233,.22); border-radius: ${vertical ? 24 : 20}px;
  padding: ${vertical ? "36px 44px" : "28px 36px"}; text-align: center; min-width: ${vertical ? 220 : 180}px;
}
.node-accent { border-color: #e8b64c; background: rgba(232,182,76,.10); }
.node-label { font-size: ${vertical ? 56 : 48}px; font-weight: 800; color: #f5f1e9; }
.node-sub { margin-top: 10px; font-size: ${vertical ? 30 : 26}px; color: rgba(245,241,233,.55); }
.edge { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.edge-arrow { font-size: ${vertical ? 64 : 56}px; color: #e8b64c; font-weight: 700; line-height: 1; }
.edge-label { font-size: ${vertical ? 34 : 30}px; font-weight: 700; color: #e8b64c; }
/* 对照表 */
.ktable { border-collapse: collapse; width: 100%; background: rgba(245,241,233,.04); border-radius: 16px; overflow: hidden; }
.ktable th {
  font-size: ${vertical ? 34 : 30}px; font-weight: 700; color: #e8b64c; text-align: left;
  padding: ${vertical ? "22px 30px" : "18px 24px"}; border-bottom: 2px solid rgba(232,182,76,.4);
}
.ktable td {
  font-size: ${vertical ? 36 : 32}px; color: rgba(245,241,233,.88); text-align: left;
  padding: ${vertical ? "22px 30px" : "18px 24px"}; border-bottom: 1px solid rgba(245,241,233,.12); line-height: 1.4;
}
.ktable tr:last-child td { border-bottom: none; }
/* 步骤链 */
.flow { display: flex; align-items: stretch; justify-content: center; gap: ${vertical ? 20 : 16}px; flex-wrap: wrap; }
.fstep {
  background: rgba(245,241,233,.06); border: 1px solid rgba(245,241,233,.18); border-radius: 20px;
  padding: ${vertical ? "28px 26px" : "22px 20px"}; text-align: center; min-width: ${vertical ? 200 : 170}px; max-width: ${vertical ? 260 : 220}px;
}
.fstep-no {
  width: ${vertical ? 56 : 48}px; height: ${vertical ? 56 : 48}px; margin: 0 auto ${vertical ? 16 : 12}px;
  border-radius: 999px; background: #e8b64c; color: #121110;
  font-size: ${vertical ? 34 : 30}px; font-weight: 800; line-height: ${vertical ? 56 : 48}px;
}
.fstep-label { font-size: ${vertical ? 38 : 32}px; font-weight: 700; color: #f5f1e9; line-height: 1.3; }
.fstep-sub { margin-top: 8px; font-size: ${vertical ? 27 : 24}px; color: rgba(245,241,233,.55); line-height: 1.4; }
.farrow { align-self: center; font-size: ${vertical ? 44 : 40}px; color: rgba(232,182,76,.6); font-weight: 700; }
</style></head><body>
<div class="wrap">
  ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ""}
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
  await page.screenshot({ path: outPath });
  await ctx.close();
  return outPath;
}

// One subtitle line as a full-frame TRANSPARENT PNG (text near the bottom),
// for ffmpeg overlay — this machine's ffmpeg is built without libass/drawtext.
export async function renderSubLine(text, { width, height }, outPath) {
  const esc = String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fontSize = Math.round(height * 0.032);
  const bottom = Math.round(height * 0.085);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; }
html, body { width: ${width}px; height: ${height}px; background: transparent; overflow: hidden; }
.line {
  position: absolute; left: 0; right: 0; bottom: ${bottom}px; text-align: center;
  font-family: "PingFang SC", "Hiragino Sans GB", sans-serif; font-weight: 700;
  font-size: ${fontSize}px; color: #f5f1e9; letter-spacing: .02em;
  -webkit-text-stroke: ${Math.max(2, Math.round(height * 0.004))}px rgba(0,0,0,.9);
  text-shadow: 0 ${Math.round(height * 0.003)}px ${Math.round(height * 0.01)}px rgba(0,0,0,.65);
  paint-order: stroke fill;
}
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
