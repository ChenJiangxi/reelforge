// HTML 大字卡 → PNG (Playwright). Dark editorial style, amber accent, huge type.
// Content stays above the subtitle safe zone (bottom ~17% is reserved for subs).
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/Users/macmini003/ops-bilibili/node_modules/playwright");

export function sizeFor(aspect) {
  return aspect === "16:9" ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}

export function cardHTML({ kicker = "", big = "", sub = "", foot = "", type = "text" }, { width, height }) {
  const vertical = height > width;
  const bigSize = type === "data"
    ? (vertical ? 300 : 220)
    : Math.max(90, Math.min(vertical ? 190 : 150, Math.round((vertical ? 900 : 1500) / Math.max(1, big.length) * 1.6)));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
.wrap { position: relative; text-align: center; padding: 0 ${vertical ? 70 : 160}px; max-height: ${Math.round(height * 0.72)}px; }
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
.big.data { text-shadow: none; }
.sub { margin-top: ${vertical ? 46 : 34}px; font-size: ${vertical ? 46 : 40}px; line-height: 1.5; color: rgba(245,241,233,.82); font-weight: 500; }
.foot { position: absolute; left: 0; right: 0; bottom: ${Math.round(height * 0.2)}px; text-align: center; font-size: ${vertical ? 28 : 24}px; color: rgba(245,241,233,.38); letter-spacing: .1em; }
.bar { width: ${vertical ? 96 : 80}px; height: 6px; border-radius: 3px; background: #e8b64c; margin: ${vertical ? "54px" : "40px"} auto 0; }
</style></head><body>
<div class="wrap">
  ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ""}
  <div class="big ${type === "data" ? "data" : ""}">${esc(big)}</div>
  ${type === "data" ? `<div class="bar"></div>` : ""}
  ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
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
