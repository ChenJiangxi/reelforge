// LLM 输出的校验器:每条问题写清"第几项、哪里不对、应该是什么",交给 chatJSON 做一次定向补正
// (学 MuseDock contracts.js / structuredDraft.js)。以前这些问题要么在后面被默默丢掉
// (停顿版和台词对不上 → 整拍不要停顿了),要么直接 FAILED。
const PAUSE = /<#[\d.]+#>/g;
const BEATS = new Set(["hook", "context", "evidence", "turn", "landing"]);
const CARD_TYPES = new Set(["text", "data", "quote", "contrast", "step", "diagram", "table", "flow"]);
const THEMES = new Set(["dark", "paper", "gradient"]);
const len = (s) => [...String(s ?? "")].length;
const brief = (s, n = 18) => {
  const t = String(s ?? "");
  return len(t) > n ? `${[...t].slice(0, n).join("")}…` : t;
};

// 找出 tts 相对 text 改了哪儿,给模型一个能照着改的具体位置
function diffHint(text, tts) {
  const a = [...text];
  const b = [...String(tts).replace(PAUSE, "")];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `从第 ${i + 1} 个字起不同:text 是「${a.slice(i, i + 8).join("")}」,tts 是「${b.slice(i, i + 8).join("")}」`;
}

// 停顿标记写坏了的常见样子:<#0.4>、<0.4#>、<# 0.4 #>、<#0.4秒#> —— 程序直接规整成 <#0.4#>,不用麻烦模型
export function fixPauses(s) {
  return String(s ?? "").replace(/<\s*#?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*#?\s*>/g, "<#$1#>");
}

function clipIssues(c, i, { requireVisual = true } = {}) {
  if (c && typeof c === "object" && c.tts != null) c.tts = fixPauses(c.tts); // 先规整,再挑毛病
  const at = `第 ${i + 1} 拍${c?.name ? `(${c.name})` : ""}`;
  const out = [];
  if (!c || typeof c !== "object") return [`${at}不是对象`];
  const text = String(c.text ?? "");
  if (!text.trim()) out.push(`${at}的 text 是空的`);
  if (/<#[\d.]+#>/.test(text)) out.push(`${at}的 text 里混进了停顿标记 <#x#>,停顿只能写在 tts 里,text 保持干净`);
  if (c.tts != null && String(c.tts).replace(PAUSE, "") !== text.replace(PAUSE, "")) {
    out.push(`${at}的 tts 去掉停顿标记后和 text 不一致,${diffHint(text.replace(PAUSE, ""), c.tts)}。tts 只能在 text 原文里插 <#x#>,一个字都不能改`);
  }
  if (c.beat != null && !BEATS.has(c.beat)) out.push(`${at}的 beat 是「${c.beat}」,必须是 hook|context|evidence|turn|landing 之一`);
  const g = Number(c.say?.gap_after);
  if (c.say?.gap_after != null && !(g >= 0.05 && g <= 0.8)) out.push(`${at}的 say.gap_after 是 ${c.say.gap_after},要在 0.05-0.6 之间`);
  if (requireVisual && !String(c.visual ?? "").trim()) out.push(`${at}缺 visual(这拍卡上要出现什么的画面简报)`);
  return out;
}

export function validateScript(obj) {
  if (!Array.isArray(obj?.clips) || obj.clips.length < 3) return ["clips 必须是至少 3 拍的数组"];
  return obj.clips.flatMap((c, i) => clipIssues(c, i));
}

// 补念法:台词一个字都不能动,每拍都要有
export function validateDelivery(clips) {
  const want = new Map(clips.map((c) => [c.name, c]));
  return (obj) => {
    if (!Array.isArray(obj?.clips)) return ["要返回 {\"clips\":[...]}"];
    const out = [];
    const got = new Set();
    obj.clips.forEach((d, i) => {
      const src = want.get(d?.name);
      if (!src) {
        out.push(`第 ${i + 1} 项的 name「${d?.name}」不在原稿里(原稿是 ${[...want.keys()].join("/")})`);
        return;
      }
      got.add(d.name);
      if (d.tts != null) d.tts = fixPauses(d.tts);
      if (d.tts != null && String(d.tts).replace(PAUSE, "") !== src.text) {
        out.push(`${d.name} 的 tts 去掉停顿标记后和原句不一致,${diffHint(src.text, d.tts)}`);
      }
    });
    const missing = [...want.keys()].filter((n) => !got.has(n));
    if (missing.length) out.push(`漏了这几拍:${missing.join("/")},每一拍都要给`);
    return out;
  };
}

// 画面卡:卡型对应的字段要齐,字数别超(超了排版一定溢出)
export function validateCard(assetNames = []) {
  return (c) => {
    if (!c || typeof c !== "object") return ["要返回一个 JSON 对象"];
    if (c.asset) return assetNames.includes(c.asset) ? [] : [`asset「${c.asset}」不在素材库里(素材库有:${assetNames.join("、") || "空"}),不用素材就正常设计卡`];
    const out = [];
    if (!CARD_TYPES.has(c.type)) out.push(`type 是「${c.type}」,必须是 text|data|quote|contrast|step|diagram|table|flow 之一`);
    if (c.theme != null && !THEMES.has(c.theme)) out.push(`theme 是「${c.theme}」,必须是 dark|paper|gradient 之一`);
    if (len(c.kicker) > 14) out.push(`kicker「${brief(c.kicker)}」${len(c.kicker)} 字,最多 12 字`);
    if (len(c.sub) > 26) out.push(`sub「${brief(c.sub)}」${len(c.sub)} 字,最多 20 字`);
    const bigMax = c.type === "table" || c.type === "flow" ? 14 : 12;
    if (len(c.big) > bigMax) out.push(`big「${brief(c.big)}」${len(c.big)} 字,最多 ${bigMax - 2} 字`);
    if (c.type === "diagram") {
      if (!Array.isArray(c.nodes) || c.nodes.length < 2) out.push("diagram 要有至少 2 个 nodes");
      else c.nodes.forEach((n, i) => {
        if (!String(n?.label ?? "").trim()) out.push(`nodes 第 ${i + 1} 个没有 label`);
        else if (len(n.label) > 8) out.push(`nodes 第 ${i + 1} 个 label「${brief(n.label)}」太长,最多 6 字`);
      });
    } else if (c.type === "table") {
      if (!Array.isArray(c.cols) || c.cols.length < 2) out.push("table 要有至少 2 个 cols(列头)");
      if (!Array.isArray(c.rows) || !c.rows.length) out.push("table 要有至少 1 行 rows");
      else c.rows.forEach((r, i) => {
        if (!Array.isArray(r) || (Array.isArray(c.cols) && r.length !== c.cols.length)) out.push(`rows 第 ${i + 1} 行有 ${Array.isArray(r) ? r.length : 0} 格,要和列头一样是 ${c.cols?.length ?? "?"} 格`);
      });
      if (Array.isArray(c.rows) && c.rows.length > 5) out.push(`table 有 ${c.rows.length} 行,竖屏最多放 4 行`);
    } else if (c.type === "flow") {
      if (!Array.isArray(c.steps) || c.steps.length < 2) out.push("flow 要有至少 2 个 steps");
      else if (c.steps.length > 5) out.push(`flow 有 ${c.steps.length} 步,最多 4 步`);
    } else if (c.type === "contrast") {
      if (!String(c.big ?? "").trim() || !String(c.big2 ?? "").trim()) out.push("contrast 要同时有 big(左边)和 big2(右边)");
    } else if (c.type === "data") {
      if (!/\d/.test(String(c.big ?? ""))) out.push(`data 卡的 big 必须是数字本体,现在是「${brief(c.big)}」`);
    } else if (!String(c.big ?? "").trim()) {
      out.push("big(主信息)是空的");
    }
    return out;
  };
}

export function validateTopic(o) {
  const out = [];
  if (!String(o?.angle ?? "").trim()) out.push("angle(角度)是空的");
  if (!String(o?.hook ?? "").trim()) out.push("hook(开场钩子)是空的");
  if (!Array.isArray(o?.claims) || o.claims.length < 2) out.push("claims 要有 3-4 条");
  return out;
}

export function validateCover(o) {
  const out = [];
  if (!String(o?.main ?? "").trim()) out.push("main(封面主标题)是空的");
  else if (len(o.main) > 10) out.push(`main「${brief(o.main)}」${len(o.main)} 字,封面巨字最多 8 字`);
  if (len(o?.sub) > 16) out.push(`sub「${brief(o.sub)}」${len(o.sub)} 字,最多 12 字`);
  return out;
}

export function validateCaption(o) {
  const out = [];
  if (!String(o?.title ?? "").trim()) out.push("title 是空的");
  else if (len(o.title) > 34) out.push(`title ${len(o.title)} 字,最多 30 字`);
  if (!Array.isArray(o?.hashtags) || o.hashtags.length < 3) out.push("hashtags 要 5-8 个");
  else o.hashtags.forEach((h, i) => {
    if (!String(h).startsWith("#")) out.push(`hashtags 第 ${i + 1} 个「${brief(h, 10)}」要以 # 开头`);
  });
  if (!String(o?.desc ?? "").trim()) out.push("desc(简介)是空的");
  return out;
}

/** 补正的结果写进决定清单:改好了几处、还剩什么 */
export function repairDecisions(obj, what, beat) {
  const out = [];
  if (obj?.__repaired) out.push({ beat, topic: "补正", choice: `${what}第一版有问题,指名让它改好了 ${obj.__repaired} 处`, why: "问题和改法都在「调用记录」里" });
  if (obj?.__issues?.length) out.push({ beat, topic: "补正", choice: `${what}还剩 ${obj.__issues.length} 处没改好`, why: obj.__issues.slice(0, 3).join(";"), warn: true });
  return out;
}
