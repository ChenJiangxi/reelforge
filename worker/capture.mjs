// 录产品页(照 ops-bilibili 的 capture-phone.mjs / rec-dl.js):
//   真手机尺寸打开页面(430×932,设备像素比 3 → 1290 宽;再高 canvas 会缩到左上角)→ 清理页面
//   → 把内层滚动区展开 → 量每段文字的位置(按行)→ 截整页长图 → 按 4096 高切片。
// 产物是一个「产品页」素材:<名字>.page.json + <名字>.page-<i>.png,在分镜里用「页面镜头」「手机镜头」推镜。
//
// 登录:按域名存 Playwright 的登录状态在 ~/.reelforge/auth/<域名>.json(只本机账号可读,不进仓库);
// 跳到登录页就用加密存储里的账号重登一次(目前只接了 auramate.com.cn)。
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { ffmpeg } from "./ffmpeg.mjs";

const require = createRequire(import.meta.url);
// Playwright 借用 ops-bilibili 装好的那份(带 Chromium);换机器时用 PLAYWRIGHT_PATH 指过去
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "/Users/macmini003/ops-bilibili/node_modules/playwright");

const AUTH_DIR = join(homedir(), ".reelforge", "auth");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
export const PHONE = { width: 430, height: 932, dsf: 3 };
const TILE = 4096;

const authFile = (host) => join(AUTH_DIR, `${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);

/** 用加密存储里的账号登录一次,存登录状态。账号密码只经 secret exec 进子进程的环境变量,不落盘不打印 */
export function login(host) {
  if (host !== "auramate.com.cn") throw new Error(`${host} 还没接自动登录;先在渲染机上手动存一份登录状态到 ${authFile(host)}`);
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const script = join(import.meta.dirname, "capture-login.mjs");
  execFileSync("secret", ["exec", "AURAMATE_EMAIL", "AURAMATE_PASSWORD", "--", process.execPath, script, host, authFile(host)], { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  if (!existsSync(authFile(host))) throw new Error("登录没成功(没存下登录状态)");
  chmodSync(authFile(host), 0o600);
}

// 页面清理:只藏不改数据。演示档案条(测试号里的人名)、开发标记、弹窗、调试面板
const CLEAN = `(() => {
  const out = { hidden: [] };
  const txt = (e) => (e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim();
  const hide = (e, why) => { if (!e) return; e.style.setProperty("display", "none", "important"); out.hidden.push(why); };
  const style = document.createElement("style");
  style.textContent = "[data-nextjs-toast],nextjs-portal,[data-testid=debug-panel-toggle]{display:none!important}";
  document.head.appendChild(style);
  // 演示档案 chips 行(加档案 按钮所在的整行)
  const add = [...document.querySelectorAll("button")].find((e) => txt(e) === "加档案");
  if (add) { let c = add; for (let i = 0; i < 6 && c.parentElement; i++) { c = c.parentElement; if (c.getBoundingClientRect().width >= innerWidth * 0.85) break; } hide(c, "档案条"); }
  // 调试面板
  const dbg = [...document.querySelectorAll("div,section")].find((e) => e.children.length && txt(e).startsWith("灵体调试面板"));
  if (dbg) { let c = dbg; while (c.parentElement && c.getBoundingClientRect().height < 260) c = c.parentElement; hide(c, "调试面板"); }
  // 弹窗:点最上层的 关闭/知道了/确定
  for (const b of [...document.querySelectorAll("button")].reverse()) { if (/^(关闭|知道了|确定|我知道了)$/.test(txt(b)) && b.getBoundingClientRect().width > 0) { b.click(); out.hidden.push("弹窗"); break; } }
  return out;
})()`;

// 把内层滚动区展开,整页才能一次截全(页面在内层 div 里滚,滚 window 没用)
const FLATTEN = `(() => {
  const sc = [...document.querySelectorAll("div,main")].filter((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!sc) return document.documentElement.scrollHeight;
  const h = sc.scrollHeight;
  sc.style.height = h + "px"; sc.style.maxHeight = "none"; sc.style.overflow = "visible";
  document.documentElement.style.height = "auto"; document.body.style.height = "auto"; document.body.style.overflow = "visible";
  for (let r = sc.parentElement; r && r !== document.body; r = r.parentElement) { r.style.height = "auto"; r.style.maxHeight = "none"; r.style.overflow = "visible"; }
  return Math.max(h, document.documentElement.scrollHeight);
})()`;

// 量文字:每个"叶子"(自己有字、没有可见子元素)记下文字、外框、每一行的外框和这一行是第几个字到第几个字;
// 再挑出标题(字大、加粗)和它所在的卡片,当作"分区"
const MEASURE = `(() => {
  const txt = (e) => (e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim();
  const leaves = [];
  const sy = window.scrollY;
  for (const e of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,div,li,button,strong,em,b,td,th,a,label")) {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if ([...e.children].some((c) => c.getBoundingClientRect().width > 0 && txt(c))) continue;
    const t = txt(e);
    if (!t || t.length > 160) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || +cs.opacity < 0.2) continue;
    // 按行:逐字取 Range 的位置,top 变了就是换行
    const lines = [];
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let n, idx = 0, cur = null;
    while ((n = walker.nextNode())) {
      const s = n.nodeValue;
      for (let k = 0; k < s.length; k++) {
        if (/\\s/.test(s[k])) continue;
        const rg = document.createRange(); rg.setStart(n, k); rg.setEnd(n, k + 1);
        const b = rg.getBoundingClientRect();
        if (!b.width) { idx++; continue; }
        if (!cur || Math.abs(b.top - cur.top) > b.height * 0.5) {
          cur = { i0: idx, i1: idx + 1, x: b.left, top: b.top, r: b.right, b: b.bottom };
          lines.push(cur);
        } else { cur.i1 = idx + 1; cur.r = Math.max(cur.r, b.right); cur.b = Math.max(cur.b, b.bottom); cur.x = Math.min(cur.x, b.left); }
        idx++;
      }
    }
    leaves.push({
      t, x: Math.round(r.left), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height),
      fs: parseFloat(cs.fontSize), fw: +cs.fontWeight || 400,
      lines: lines.map((l) => ({ i0: l.i0, i1: l.i1, x: Math.round(l.x), y: Math.round(l.top + sy), w: Math.round(l.r - l.x), h: Math.round(l.b - l.top) })),
    });
  }
  // 分区:加粗的短标题(报告页的卡片标题是 16px/600:总论、夫妻宫、正缘画像…),数字(分数)不算
  const sections = [];
  for (const L of leaves) {
    if (L.fs < 16 || L.fw < 600 || L.t.length > 12 || /^[\d\s.%+\-/:分]+$/.test(L.t)) continue;
    if (sections.length && sections[sections.length - 1].title === L.t) continue;
    sections.push({ title: L.t, y: L.y });
  }
  return { cssW: innerWidth, cssH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), leaves, sections };
})()`;

/**
 * 录一个产品页。返回 {jsonPath, tiles:[路径], layout}
 * opts: { url, name, outDir, wait(ms) }
 */
export async function capturePage({ url, name, outDir, wait = 15000 }) {
  const host = new URL(url).host;
  mkdirSync(outDir, { recursive: true });
  const b = await chromium.launch();
  try {
    const open = async () => {
      const ctx = await b.newContext({
        viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.dsf, isMobile: true, hasTouch: true,
        userAgent: UA, locale: "zh-CN", colorScheme: "dark",
        ...(existsSync(authFile(host)) ? { storageState: authFile(host) } : {}),
      });
      const p = await ctx.newPage();
      try {
        await p.goto(url, { waitUntil: "commit", timeout: 60000 });
      } catch {
        /* 慢页面:下面照样等 */
      }
      await p.waitForTimeout(wait);
      return { ctx, p };
    };
    let { ctx, p } = await open();
    if (/\/login/.test(p.url())) {
      await ctx.close();
      login(host);
      ({ ctx, p } = await open());
      if (/\/login/.test(p.url())) throw new Error("登录后还是跳到登录页:账号可能失效了");
    }
    const cleaned = await p.evaluate(CLEAN);
    await p.waitForTimeout(800);
    await p.evaluate(FLATTEN);
    await p.waitForTimeout(2500);
    const layout = await p.evaluate(MEASURE);
    const full = join(outDir, `${name}.page-full.png`);
    await p.screenshot({ path: full, fullPage: true });
    await ctx.close();
    // 切片:Chromium 单张纹理有上限,太高的图 Remotion 里会画不出来
    const pxH = Math.round(layout.cssH * PHONE.dsf);
    const pxW = Math.round(layout.cssW * PHONE.dsf);
    const tiles = [];
    for (let y = 0, i = 0; y < pxH; y += TILE, i++) {
      const h = Math.min(TILE, pxH - y);
      const tp = join(outDir, `${name}.page-${i}.png`);
      await ffmpeg(["-i", full, "-vf", `crop=${pxW}:${h}:0:${y}`, "-frames:v", "1", tp]);
      tiles.push({ file: `${name}.page-${i}.png`, y: y / PHONE.dsf, h: h / PHONE.dsf, path: tp });
    }
    const doc = {
      kind: "page", name, url, captured: new Date().toISOString(), dsf: PHONE.dsf, cssW: layout.cssW, cssH: layout.cssH,
      viewportH: PHONE.height, tiles: tiles.map(({ file, y, h }) => ({ file, y, h })), sections: layout.sections, leaves: layout.leaves, cleaned: cleaned.hidden,
    };
    const jsonPath = join(outDir, `${name}.page.json`);
    writeFileSync(jsonPath, JSON.stringify(doc));
    return { jsonPath, tiles, layout: doc, fullPath: full };
  } finally {
    await b.close();
  }
}

export function readPage(jsonPath) {
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}
