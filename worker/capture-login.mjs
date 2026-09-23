// 登录产品站,存 Playwright 登录状态(照 ops-bilibili lingban-shadow-4angles/script/login.mjs)。
// 用法(由 capture.mjs 调):secret exec AURAMATE_EMAIL AURAMATE_PASSWORD -- node capture-login.mjs <域名> <存到哪>
// 账号密码只从环境变量读,不打印;失败时只说卡在哪一步。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/macmini003/ops-bilibili/node_modules/playwright");
const [host, out] = process.argv.slice(2);
const EMAIL = process.env.AURAMATE_EMAIL;
const PW = process.env.AURAMATE_PASSWORD;
if (!EMAIL || !PW) {
  console.error("缺登录账号(环境变量没注入)");
  process.exit(2);
}
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, locale: "zh-CN", colorScheme: "dark" });
  const p = await ctx.newPage();
  try {
    await p.goto(`https://${host}/login`, { waitUntil: "commit", timeout: 60000 });
  } catch {
    /* 下面等 */
  }
  await p.waitForTimeout(7000);
  const dump = () =>
    p.evaluate(() => ({
      btns: [...document.querySelectorAll("button")].map((e, i) => ({ i, t: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 24), v: e.getBoundingClientRect().width > 0 })).filter((x) => x.v),
      inputs: [...document.querySelectorAll("input")].map((e, i) => ({ i, ph: e.placeholder, ty: e.type, v: e.getBoundingClientRect().width > 0 })).filter((x) => x.v),
    }));
  let d = await dump();
  const tab = d.btns.find((x) => x.t === "密码登录");
  if (!tab) throw new Error("登录页找不到「密码登录」");
  await p.locator("button").nth(tab.i).click();
  await p.waitForTimeout(1500);
  d = await dump();
  const acct = d.inputs.find((x) => /手机号|邮箱/.test(x.ph || ""));
  const pwd = d.inputs.find((x) => x.ty === "password" || /密码/.test(x.ph || ""));
  if (!acct || !pwd) throw new Error("找不到账号/密码输入框");
  await p.locator("input").nth(acct.i).fill(EMAIL);
  await p.locator("input").nth(pwd.i).fill(PW);
  const submit = d.btns.find((x) => /^登\s*录(\s*\/\s*注\s*册)?$/.test(x.t) && !/使用|微信|Apple|Google/.test(x.t));
  if (!submit) throw new Error("找不到登录按钮");
  await p.locator("button").nth(submit.i).click();
  await p.waitForTimeout(10000);
  if (/\/login/.test(p.url())) throw new Error("点了登录还停在登录页");
  await ctx.storageState({ path: out });
  console.log("登录状态已存");
} finally {
  await b.close();
}
