// 产品页素材(worker/capture.mjs 录的 <短名>.page.json + 切片图)在管线里怎么用:
//   素材阶段:把页面上有哪些字(按分区)写进排镜头的提示词,校验 focus 是不是页面上真有的字
//   剪辑阶段:下载 json 和切片,放进 Remotion 的 public/,给「产品页」镜头塞上页面数据(p.__page)
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { downloadCached } from "./board.mjs";
import { stagePublic } from "./remotion/render.mjs";
import { findText, pageDigest } from "../shots/page.mjs";

export { pageDigest };

const tileUrl = (jsonUrl, file) => jsonUrl.replace(/[^/?]+\.page\.json(\?.*)?$/, `${encodeURIComponent(file)}$1`);

/** 下载项目里所有产品页的 json:返回 Map 名字 → {asset, doc, jsonPath} */
export async function loadPages(assets, dir) {
  const out = new Map();
  for (const a of assets) {
    if (a.kind !== "page") continue;
    try {
      const jsonPath = await downloadCached(a.url, join(dir, a.file || `${a.name}.page.json`));
      out.set(a.name, { asset: a, doc: JSON.parse(readFileSync(jsonPath, "utf8")), jsonPath });
    } catch (e) {
      console.log(`  [pages] 产品页「${a.name}」下载失败:${e.message}`);
    }
  }
  return out;
}

/** 校验一个「产品页」镜头:页面在素材库里、每个 focus 是页面上真有的字 */
export function pageShotIssues(s, at, pages) {
  const out = [];
  const pg = pages.get(String(s.p?.page ?? ""));
  if (!pg) {
    out.push(`${at} 的 page「${s.p?.page ?? ""}」不是素材库里的产品页,只能是 ${[...pages.keys()].map((n) => `"${n}"`).join("、") || "(没有产品页)"}`);
    return out;
  }
  const focus = Array.isArray(s.p.focus) ? s.p.focus : [];
  for (const q of focus) {
    const hit = findText(pg.doc, q);
    if (!hit || !hit.whole) out.push(`${at} 的 focus「${q}」在产品页「${pg.asset.name}」上找不到原文 —— 从页面文字清单里一字不差地抄(可以只抄一段里的几个字)`);
  }
  return out;
}

/**
 * 剪辑/缩略图渲染前:下载切片放进 Remotion 的 public/,返回给镜头用的页面数据。
 * captured 进名字和数据里:重录同一个页面(文件名不变)时缓存会失效、不会用到旧图
 */
export async function pageProps(pg, dir, workRoot) {
  const { doc, asset } = pg;
  const stamp = String(Date.parse(doc.captured) || 0).slice(-9);
  const files = [];
  for (const t of doc.tiles || []) {
    const local = await downloadCached(tileUrl(asset.url, t.file), join(dir, t.file));
    files.push({ path: local, name: `pages/${stamp}-${t.file}` });
  }
  const names = await stagePublic(workRoot, files);
  return {
    cssW: doc.cssW,
    cssH: doc.cssH,
    viewportH: doc.viewportH,
    captured: doc.captured,
    tiles: (doc.tiles || []).map((t, k) => ({ src: names[k], y: t.y, h: t.h })),
    leaves: doc.leaves || [],
  };
}

/** 一组镜头里的「产品页」镜头都塞上页面数据;找不到页面的保持原样(模板会显示"还没录") */
export async function withPages(shots, pages, dir, workRoot, memo = new Map()) {
  const out = [];
  for (const s of shots) {
    if (s?.tpl !== "page") {
      out.push(s);
      continue;
    }
    const pg = pages.get(String(s.p?.page ?? ""));
    if (!pg) {
      out.push(s);
      continue;
    }
    if (!memo.has(pg.asset.name)) memo.set(pg.asset.name, await pageProps(pg, dir, workRoot));
    out.push({ ...s, p: { ...s.p, __page: memo.get(pg.asset.name) } });
  }
  return out;
}
