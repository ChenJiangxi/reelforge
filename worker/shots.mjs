// 镜头规划:每拍从"一张字卡"变成 1-4 个镜头(学 ops-bilibili 的分镜:一拍里念到哪切到哪)。
// 模板本身在 shots/(React/Remotion,网页预览和渲染机共用);这里管三件事:
//   1. 把模板目录写进提示词,让 LLM 给每拍排镜头、填内容
//   2. 校验它排的(切点是不是台词原文、字数、同一模板不许扎堆、数字必须真有出处)
//   3. 规整成渲染要的结构
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shotCountFor, spokenLen, cleanText, CHARS_PER_SEC } from "../shots/timing.mjs";
import { TASTE, playbook } from "./prompts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG = JSON.parse(readFileSync(join(HERE, "..", "shots", "catalog.json"), "utf8")).templates;
export const TPL = Object.fromEntries(CATALOG.map((t) => [t.id, t]));
export const TPL_LABEL = Object.fromEntries(CATALOG.map((t) => [t.id, t.label]));
const DATA_TPL = new Set(["number", "gauge", "bars", "timeline", "evidence", "pillars"]);
export const SHOT_THEMES = ["ink", "paper", "dusk"];
/** 画面镜头(AI 生图)默认关闭:要花钱,必须她同意用哪家、开了才用(2026-09-23 她明确说过不许擅自用 OpenRouter 生图) */
export const SCENE_ON = process.env.SCENE_IMAGES === "on";
const len = (s) => [...String(s ?? "")].length;
const brief = (s, n = 16) => (len(s) > n ? `${[...String(s)].slice(0, n).join("")}…` : String(s ?? ""));

function fieldDoc(f) {
  const opt = f.optional ? ",可省" : "";
  if (f.type === "text") return `"${f.key}": 字符串(≤${f.max} 字${opt}) —— ${f.label}`;
  if (f.type === "number") return `"${f.key}": 数字${opt} —— ${f.label}`;
  if (f.type === "select") return `"${f.key}": ${f.options.map((o) => `"${o}"`).join("|")}${opt} —— ${f.label}`;
  if (f.type === "list") return `"${f.key}": [字符串 ${f.min}-${f.max} 个,每个 ≤${f.itemMax} 字]${opt} —— ${f.label}`;
  if (f.type === "items") return `"${f.key}": [{${f.of.map((x) => `"${x.key}"${x.optional ? "?" : ""}: ${x.type === "number" ? "数字" : `≤${x.max}字`}`).join(", ")}} ${f.min}-${f.max} 个] —— ${f.label}`;
  if (f.type === "side") return `"${f.key}": {"title": ≤6字, "lines": [≤10字 × 1-3]} —— ${f.label}`;
  if (f.type === "rows") return `"${f.key}": [[每格 ≤${f.itemMax} 字]] ${f.min}-${f.max} 行 —— ${f.label}`;
  if (f.type === "hidden") return "";
  return `"${f.key}"`;
}

export function catalogText() {
  return CATALOG.filter((t) => SCENE_ON || t.id !== "scene").map((t) => `■ ${t.id}(${t.label}):${t.use}\n   p: ${t.fields.map(fieldDoc).filter(Boolean).join(";")}\n   例:${JSON.stringify(t.example)}`).join("\n");
}

/** 这拍大概念多久(秒) */
export const estDur = (text) => spokenLen(text) / CHARS_PER_SEC;

// ── 校验 ─────────────────────────────────────────────────────────────

function fieldIssues(f, v, at) {
  const out = [];
  const miss = v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
  if (miss) {
    if (!f.optional && !(f.min === 0)) out.push(`${at} 缺 ${f.key}(${f.label})`);
    return out;
  }
  if (f.type === "text" && len(String(v).replace(/\s/g, "")) > f.max) out.push(`${at} 的 ${f.key}「${brief(v)}」${len(v)} 字,最多 ${f.max} 字 —— 删字,别写成整句台词`);
  if (f.type === "number" && !Number.isFinite(Number(v))) out.push(`${at} 的 ${f.key} 要是数字,现在是「${brief(v)}」`);
  if (f.type === "select" && !f.options.includes(v)) out.push(`${at} 的 ${f.key} 只能是 ${f.options.join("|")}`);
  if (f.type === "list") {
    if (!Array.isArray(v)) out.push(`${at} 的 ${f.key} 要是字符串数组`);
    else {
      if (v.length < f.min || v.length > f.max) out.push(`${at} 的 ${f.key} 要 ${f.min}-${f.max} 个,现在 ${v.length} 个`);
      v.forEach((x, k) => {
        if (len(x) > f.itemMax) out.push(`${at} 的 ${f.key}[${k}]「${brief(x)}」超过 ${f.itemMax} 字`);
      });
    }
  }
  if (f.type === "items") {
    if (!Array.isArray(v)) out.push(`${at} 的 ${f.key} 要是对象数组`);
    else {
      if (v.length < f.min || v.length > f.max) out.push(`${at} 的 ${f.key} 要 ${f.min}-${f.max} 个,现在 ${v.length} 个`);
      v.forEach((x, k) => {
        for (const sub of f.of) out.push(...fieldIssues(sub, x?.[sub.key], `${at} 的 ${f.key}[${k}]`));
      });
    }
  }
  if (f.type === "side") {
    if (!v?.title) out.push(`${at} 的 ${f.key} 缺 title`);
    else if (len(v.title) > 6) out.push(`${at} 的 ${f.key}.title「${brief(v.title)}」超过 6 字`);
    for (const [k, l] of (v?.lines || []).entries()) if (len(l) > 10) out.push(`${at} 的 ${f.key}.lines[${k}]「${brief(l)}」超过 10 字`);
  }
  if (f.type === "rows") {
    if (!Array.isArray(v) || !v.every(Array.isArray)) out.push(`${at} 的 ${f.key} 要是二维数组`);
    else if (v.length < f.min || v.length > f.max) out.push(`${at} 的 ${f.key} 要 ${f.min}-${f.max} 行`);
  }
  return out;
}

/** 数据类镜头里的数字/干支必须在台词或参考材料里真有 —— 不许编 */
function dataIssues(s, at, source) {
  const out = [];
  if (!DATA_TPL.has(s.tpl)) return out;
  const nums = [];
  const p = s.p || {};
  const push = (x) => {
    const m = String(x ?? "").match(/\d+(?:\.\d+)?/g);
    if (m) nums.push(...m);
  };
  if (s.tpl === "number" || s.tpl === "gauge") push(p.value);
  if (s.tpl === "bars") (p.items || []).forEach((x) => push(x?.value));
  if (s.tpl === "timeline") (p.points || []).forEach((x) => push(x?.value));
  if (s.tpl === "evidence") push(p.score);
  const missing = [...new Set(nums)].filter((n) => !source.includes(n) && !source.includes(toChineseNum(n)));
  if (missing.length) out.push(`${at} 用了台词和参考材料里都没有的数字 ${missing.slice(0, 4).join("、")} —— 不许编数据;没有真数字就换成非数据类模板`);
  if (s.tpl === "pillars") {
    const gz = (p.cols || []).flatMap((c) => [c?.top, c?.bottom]).filter(Boolean);
    const bad = gz.filter((g) => !source.includes(g));
    if (bad.length > 1) out.push(`${at} 的四柱干支(${bad.slice(0, 4).join("")})在台词和参考材料里没出现 —— 没有具体八字就别用 pillars`);
  }
  return out;
}

const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function toChineseNum(n) {
  // 口播里常念成汉字:"二零三二年""八十九分"—— 逐位的写法够用来判断"台词里有没有提到"
  return [...String(n)].map((d) => CN[Number(d)] ?? d).join("");
}

export function shotIssues(s, at, text, source) {
  if (!s || typeof s !== "object") return [`${at} 不是对象`];
  const out = [];
  if (s.asset) return out;
  const t = TPL[s.tpl];
  if (!t) return [`${at} 的 tpl「${s.tpl}」不存在,只能是 ${CATALOG.map((x) => x.id).join("|")} 之一(或者写 asset 用素材库)`];
  if (!s.p || typeof s.p !== "object") return [`${at} 缺 p(镜头内容)`];
  for (const f of t.fields) out.push(...fieldIssues(f, s.p[f.key], at));
  if (s.tpl === "quote" && s.p.em && !String(s.p.text || "").includes(s.p.em)) out.push(`${at} 的 em「${s.p.em}」必须是 text 里的原文`);
  if (s.tpl === "scene") {
    const pr = String(s.p.prompt ?? "");
    if (len(pr) < 12) out.push(`${at} 的 prompt 太短 —— 写清楚谁、在哪、在做什么、什么光线和情绪`);
    if (/文字|写着|字样|标语|招牌|logo|标题/i.test(pr)) out.push(`${at} 的 prompt 要求画面里有字 —— 生成的图里的字全是乱码,字只能放在 big 里`);
    if (/口播者|主持人|直视镜头|对着镜头说/.test(pr)) out.push(`${at} 画的是口播者对着镜头说话 —— 这条片没有真人出镜,换成这句话讲的场景或意象`);
    if (/下一秒|然后|接着|随后|切到|画面一转|前后对比|左边.*右边|上半.*下半/.test(pr)) out.push(`${at} 的 prompt 写了两个瞬间 —— 一张图只能画一个瞬间(不然会生成拼接的两格),要对比就拆成两个 scene`);
  }
  if (s.tpl === "diagram" && Array.isArray(s.p.links) && Array.isArray(s.p.nodes) && s.p.links.length > Math.max(0, s.p.nodes.length - 1)) out.push(`${at} 的 links 要比 nodes 少一个`);
  if (s.tpl === "table" && Array.isArray(s.p.rows) && Array.isArray(s.p.cols)) {
    const bad = s.p.rows.findIndex((r) => Array.isArray(r) && r.length !== s.p.cols.length);
    if (bad >= 0) out.push(`${at} 的 rows[${bad}] 格数和列头(${s.p.cols.length} 列)不一样`);
  }
  out.push(...dataIssues(s, at, source));
  const url = JSON.stringify({ ...s.p, src: undefined, srcKey: undefined }).match(/(https?:\/\/|www\.|[a-z0-9-]{2,}\.(com|cn|net|org|io|cc|app)(\b|\/))/i);
  if (url) out.push(`${at} 的字里有网址「${url[0]}」—— 片内不许出网址,删掉`);
  // 屏幕上的字不是字幕:整句照抄台词没有意义(字幕已经有了)
  const onScreen = JSON.stringify({ ...s.p, prompt: undefined, src: undefined });
  const longCopy = cleanText(text).length >= 16 && cleanText(onScreen).includes(cleanText(text).slice(0, 14));
  if (longCopy) out.push(`${at} 把整句台词照抄上了屏幕 —— 字幕已经有这句,画面上只放关键词、术语、数字`);
  return out;
}

/**
 * 整片镜头规划的校验器(交给 chatJSON 做一次定向补正)。
 * want: [{name, text}] 这次要规划的拍;fixed: 不用它规划的拍(沿用/她改过的)按顺序带上,用来查相邻重复
 */
/** 汉字两两相连的片段(去标点),用来粗比"这段字像哪一拍的台词" */
function bigrams(s) {
  const t = [...cleanText(s)].filter((ch) => /\p{Script=Han}/u.test(ch));
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t[i] + t[i + 1]);
  return out;
}

export function validatePlan(want, fixedByName, source, assetNames = [], allOrder = null, fixedText = null, castKnown = false) {
  const order = want.map((w) => w.name);
  return (obj) => {
    const out = [];
    if (!obj || !Array.isArray(obj.beats)) return ['要返回 {"theme": "...", "beats": [{"name": "c01", "shots": [...]}]}'];
    if (obj.theme && !SHOT_THEMES.includes(obj.theme)) out.push(`theme 只能是 ${SHOT_THEMES.join("|")}`);
    const usesMain = (obj.beats || []).some((b) => (b?.shots || []).some((s) => s?.tpl === "scene" && s.p?.who === "main"));
    if (usesMain && !castKnown && [...String(obj.cast?.main ?? "")].length < 10) out.push('有画面写了 who: "main",但 cast.main 没写主角长什么样(年龄、发型、穿着、气质)');
    const byName = new Map(obj.beats.map((b) => [b?.name, b]));
    const missing = order.filter((n) => !byName.has(n));
    if (missing.length) out.push(`缺了 ${missing.join("、")} 的镜头`);
    for (const w of want) {
      const b = byName.get(w.name);
      if (!b) continue;
      const shots = Array.isArray(b.shots) ? b.shots : [];
      const at0 = `${w.name}`;
      const need = shotCountFor(w.text);
      if (!shots.length) {
        out.push(`${at0} 没有镜头`);
        continue;
      }
      if (shots.length > 4) out.push(`${at0} 有 ${shots.length} 个镜头,最多 4 个`);
      // 少切是最常见的毛病(一个镜头撑 5 秒以上就又是 PPT 了):4 个的允许少 1 个,其余不许少
      if (shots.length < need - (need >= 4 ? 1 : 0) || shots.length > need + 1) out.push(`${at0} 约 ${estDur(w.text).toFixed(1)} 秒,该切 ${need} 个镜头,现在 ${shots.length} 个 —— 大约每 3 秒换一次画面`);
      let pos = -1;
      shots.forEach((s, k) => {
        const at = `${w.name} 第 ${k + 1} 个镜头`;
        out.push(...shotIssues(s, at, w.text, source));
        if (s?.asset && !assetNames.includes(s.asset)) out.push(`${at} 的素材「${s.asset}」不在素材库里`);
        if (k > 0) {
          const from = String(s?.from ?? "");
          const i = from ? cleanText(w.text).indexOf(cleanText(from)) : -1;
          if (!from || cleanText(from).length < 2) out.push(`${at} 缺 from(从台词里抄 3-8 个字,念到这里切到这个镜头)`);
          else if (i < 0) out.push(`${at} 的 from「${brief(from)}」不是台词原文 —— 必须从这拍台词里一字不差地抄`);
          else if (i <= pos) out.push(`${at} 的 from「${brief(from)}」在上一个镜头切点的前面,切点要按台词顺序`);
          else pos = i;
        }
      });
    }
    // 串拍:镜头上的字明显是相邻那拍的台词(画面会比声音早/晚一拍,2026-09-23 c02 放了 c03 的「女命看官杀」)
    const textOf = new Map((allOrder || order).map((n) => [n, (want.find((w) => w.name === n)?.text ?? fixedText?.get(n) ?? "")]));
    const names0 = allOrder || order;
    for (const w of want) {
      const b = byName.get(w.name);
      const idx = names0.indexOf(w.name);
      const own = bigrams(w.text);
      for (const [k, s] of (b?.shots || []).entries()) {
        if (!s?.tpl || !s.p) continue;
        const mine = bigrams(JSON.stringify({ ...s.p, prompt: undefined, src: undefined }));
        const score = (set) => [...mine].filter((g) => set.has(g)).length;
        const o = score(own);
        for (const nb of [names0[idx - 1], names0[idx + 1]]) {
          if (!nb) continue;
          const sc = score(bigrams(textOf.get(nb) || ""));
          if (sc >= 3 && sc > o * 2) out.push(`${w.name} 第 ${k + 1} 个镜头上的字讲的是 ${nb} 的内容(和 ${nb} 的台词重合 ${sc} 处,和本拍只有 ${o} 处)—— 画面会和声音差一拍,只放这拍自己念到的内容`);
        }
      }
    }
    // 全片:相邻镜头不许同一模板,单个模板不许扎堆
    const seq = [];
    const names = allOrder || [...new Set([...order, ...fixedByName.keys()])];
    for (const n of names) {
      const shots = byName.get(n)?.shots || fixedByName.get(n) || [];
      for (const s of shots) seq.push({ beat: n, tpl: s?.asset ? "asset" : s?.tpl, fixed: !byName.has(n) });
    }
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].tpl === seq[i - 1].tpl && seq[i].tpl !== "asset" && !(seq[i].fixed && seq[i - 1].fixed)) out.push(`${seq[i - 1].beat} 和 ${seq[i].beat} 交界处连着两个 ${seq[i].tpl} —— 相邻镜头换个模板`);
    }
    const cards = seq.filter((x) => x.tpl && x.tpl !== "asset");
    if (cards.length >= 8) {
      const count = {};
      for (const c of cards) count[c.tpl] = (count[c.tpl] || 0) + 1;
      for (const [tpl, c] of Object.entries(count)) {
        if (tpl === "scene") {
          if (c / cards.length > 0.55) out.push(`scene 用了 ${c}/${cards.length} 次,超过一半 —— 结构、对照、数字的地方还是要用图表类模板`);
        } else if (c / cards.length > 0.3) out.push(`${tpl} 用了 ${c}/${cards.length} 次,超过三成 —— 整条片会像同一个画面的变体,换几个成别的模板`);
      }
      const sceneN = count.scene || 0;
      if (!SCENE_ON && sceneN) out.push(`这台机器没开配图,不能用 scene(${sceneN} 个)—— 换成别的模板`);
      if (SCENE_ON && sceneN / cards.length < 0.28) out.push(`scene(画面)只有 ${sceneN}/${cards.length} 个 —— 片子不能全是字,讲情绪、场景、比喻、意象的镜头换成 scene,至少三成`);
      const CAP = { stomp: 2, quote: 3, ask: 3, glyph: 4 };
      for (const [tpl, cap] of Object.entries(CAP)) if ((count[tpl] || 0) > cap) out.push(`${tpl} 用了 ${count[tpl]} 次,全片最多 ${cap} 次 —— 多出来的换成别的模板`);
    }
    return out;
  };
}

/** 规整:去掉多余字段、第一个镜头不要 from、数字字段转数字 */
export function normalizeShots(shots) {
  return (shots || []).slice(0, 4).map((s, k) => {
    if (s?.asset) return { asset: String(s.asset), from: k ? String(s.from ?? "") : "" };
    const t = TPL[s?.tpl] ? s.tpl : "lines";
    const p = { ...(s?.p || {}) };
    for (const f of TPL[t].fields) {
      if (f.type === "number" && p[f.key] != null && Number.isFinite(Number(p[f.key]))) p[f.key] = Number(p[f.key]);
      if (f.type === "items") p[f.key] = (p[f.key] || []).map((x) => {
        const o = { ...x };
        for (const sub of f.of) if (sub.type === "number" && o[sub.key] != null && Number.isFinite(Number(o[sub.key]))) o[sub.key] = Number(o[sub.key]);
        return o;
      });
    }
    return { tpl: t, from: k ? String(s.from ?? "") : "", p };
  });
}

/** 决定清单里一拍的镜头写成一行:「砸字 → 左右对照(念到"女命看"切) → …」 */
export function describeShots(shots) {
  return shots.map((s, k) => `${s.asset ? `录屏「${brief(s.asset, 10)}」` : TPL_LABEL[s.tpl] ?? s.tpl}${k && s.from ? `(念到「${brief(s.from, 6)}」切)` : ""}`).join(" → ");
}

// ── 提示词 ───────────────────────────────────────────────────────────

/**
 * 整片一次规划(看得到全片才管得住"别扎堆")。
 * want: 要规划的拍 [{name, beat, text, visual}];fixed: 不用规划的拍 [{name, text, shots}](沿用的/她改过的)
 */
export function planPrompt(item, want, fixed, { assets = [], material = "", note = "", theme = null } = {}) {
  const vids = assets.filter((a) => a.kind === "video" || a.kind === "image");
  const assetBlock = vids.length
    ? `\n\n素材库(真录屏/真截图,能用就用 —— 讲到产品功能时,真素材永远比动画卡有说服力):\n${vids.map((a) => `- "${a.name}"(${a.kind === "video" ? "录屏" : "图片"}${a.global ? ",共享" : ""}${a.tone ? `,${a.tone === "dark" ? "深色画面" : "浅色画面"}` : ""})`).join("\n")}\n用法:镜头写成 {"asset": "文件名", "from": "切点"}。讲到产品、功能、报告内容的地方都用素材镜头 —— 有产品录屏的片子,真产品画面要占全片一半以上(她的规矩:「产品画面至少一半」「不是全部用 html」);别把素材放在不相关的拍上。`
    : "";
  const sceneRule = SCENE_ON
    ? `7. 片子不能全是字:全片三到五成的镜头用 scene(画面)。讲情绪、场景、人物状态("谈恋爱总踩坑""上来特别上头""深夜一个人刷手机")、比喻("红线""窗口")、命理意象(星盘、日柱、五行流转)时用 scene;讲结构、关系、对照、数字时才用图表类模板。
   scene 的 prompt 写"画什么":谁、在哪、在做什么、什么光线、什么情绪,越具体越好(例:"一对二十多岁的中国情侣在咖啡馆背对背生闷气,女生抱着手臂看向窗外,男生低头刷手机,暖色逆光");
   一张图只画一个瞬间(不写"下一秒/然后/切到",要对比就拆成两个 scene);不写画风(全片统一加),不要求画面里出现任何文字;人物统一是中国人。scene 上最多压一句 ≤10 字的关键词(big),也可以不压。
   主角:全片有人物的画面都是同一个主角,默认就是这条片的目标观众本人(口播对着"姐妹们"说 = 二十多岁的中国女生)。在 cast.main 里写一次她的样子(年龄、发型、穿着、气质,40 字以内),
   画面里有她就写 who: "main",prompt 里用"她"指代,不用再描述长相;讲"对方/另一半/老师傅"这类别人时才画别人。不要画"口播者/主持人对着镜头说话" —— 这条片没有真人出镜。
   相邻两个 scene 之间最好隔一个图表类镜头,别连着三个 scene。
`
    : "7. (这台机器没开配图,不要用 scene。)\n";
  const all = [...want.map((w) => ({ ...w, todo: true })), ...fixed.map((f) => ({ ...f, todo: false }))];
  all.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const beats = all
    .map((b) =>
      b.todo
        ? `${b.name}[${b.beat || "?"}] 约 ${estDur(b.text).toFixed(1)} 秒 → 切 ${shotCountFor(b.text)} 个镜头\n  台词:${b.text}${b.visual ? `\n  画面简报:${b.visual}` : ""}`
        : `${b.name}(已定,不用出):${describeShots(b.shots || [])}`,
    )
    .join("\n");
  return [
    {
      role: "system",
      content: `你是短视频动态分镜师。口播已经定稿,你要给每一拍排镜头:一拍切成 1-4 个镜头,念到哪句切到哪个镜头,每个镜头从模板库里选一个动效模板、填上画面内容。
目标是 ops-bilibili 那种成片:两三秒就有一次画面变化,每个画面都有信息(关系、对照、数字、术语),字大、撑满画面,不是一张张 PPT。

${TASTE}

模板库(tpl 只能从这里选):
${catalogText()}

硬规矩:
1. 切点 from:每拍第一个镜头不写 from;后面每个镜头的 from 必须从这拍台词里一字不差地抄 3-8 个字,念到这几个字就切过来,按台词顺序往后排。
2. 屏幕上的字不是字幕:字幕已经会把台词逐句打出来,画面只放提炼过的关键词、术语、关系、数字。一个字段里整句照抄台词 = 不合格。
3. 不重样:相邻两个镜头(包括上一拍的最后一个和这一拍的第一个)不许用同一个模板;${SCENE_ON ? "除了 scene," : ""}任何一个模板不许超过全片镜头的三成;stomp 全片最多 2 次。
4. 不编数据:number/gauge/bars/timeline/evidence 里的数字、pillars 里的干支,必须是台词或参考材料里真有的。没有真数字,就用 lines/glyph/diagram/compare/list 这类非数据模板。
5. 开头:第一拍的第一个镜头用 ${SCENE_ON ? "scene(压一句狠话)/ " : ""}stomp / ask / glyph / number 之一,而且 2.5 秒内要切到下一个镜头。
6. 每个镜头只讲一件事。塞不下就拆成两个镜头,别往一个模板里硬塞。
${sceneRule}8. 用台词里的具体词,不要自己总结的空词:"错误期待 / 真正价值 / 授人以渔 / 信息不对等 / 结尾落点"这种标签一律不要;标题、对照两边的名字直接用台词里的说法(星座合盘 vs 八字命盘、找老师傅 vs 自己排盘)。
9. glyph 的大字必须是这拍讲的术语或关键字本身(官、杀、伤、合、冲、偏),不是随手挑一个字;quote 只给真正能截图传播的金句,全片最多 3 次,by 只写真实出处(人名/书名),通常不写;stomp 最多 2 次,ask 最多 3 次,glyph 最多 4 次。
10. 片子里有素材镜头时,配色跟素材的明暗走(深色录屏配 ink,浅色配 paper),不然画面会在亮和暗之间来回跳。theme 选一套配色贯穿全片:ink(深墨蓝 + 香槟金,默认、严肃/揭秘/命理)、paper(暖纸 + 朱红,温暖/情感/生活)、dusk(暗紫 + 暖橙,活泼)。${theme ? `这条片之前用的是 ${theme},没有理由就别换。` : ""}

她的画面教案(原来是写给单张字卡的;卡型名以上面的模板库为准,原则照样适用):
${playbook("visual")}${assetBlock}`,
    },
    {
      role: "user",
      content: `${material ? `参考材料(数字、术语只能从这里和台词里取):\n${String(material).slice(0, 3000)}\n\n` : ""}${note ? `她的批注(必须照办):${note}\n\n` : ""}逐拍:
${beats}

返回 JSON(不要多余文字),只返回标了"切 N 个镜头"的那些拍:
${SCENE_ON ? '{"theme": "ink|paper|dusk", "cast": {"main": "主角的样子"}, "beats": [{"name": "c01", "shots": [{"tpl": "scene", "p": {"prompt": "...", "who": "main", "big": "..."}}, {"tpl": "compare", "from": "女命看", "p": {...}}, {"asset": "文件名", "from": "打开灵伴"}]}]}' : '{"theme": "ink|paper|dusk", "beats": [{"name": "c01", "shots": [{"tpl": "stomp", "p": {...}}, {"tpl": "compare", "from": "女命看", "p": {...}}, {"asset": "文件名", "from": "打开灵伴"}]}]}'}`,
    },
  ];
}
