// 渲染机上的镜头渲染:shots/ 里的模板 → mp4 / png。
// 打包(webpack)一次大约 10-20 秒,按 shots/ 源码的哈希缓存在 WORK_DIR 下,改了模板自动重打。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SHOTS = join(ROOT, "shots");
const require = createRequire(join(HERE, "package.json"));

let bundlePromise = null;
let bundleKey = null;

function srcHash() {
  const h = createHash("sha1");
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|json)$/.test(f)) h.update(f).update(readFileSync(p));
    }
  };
  walk(SHOTS);
  h.update(readFileSync(join(HERE, "entry.tsx")));
  return h.digest("hex").slice(0, 12);
}

export function shotsReady() {
  return existsSync(join(HERE, "node_modules", "@remotion", "renderer"));
}

/** 模板源码的版本号:进每拍的缓存键,改了模板旧缓存自动作废 */
export function shotsVersion() {
  return srcHash();
}

async function getBundle(workRoot) {
  const key = srcHash();
  if (bundlePromise && bundleKey === key) return bundlePromise;
  bundleKey = key;
  const out = join(workRoot, ".shots-bundle", key);
  bundlePromise = (async () => {
    if (existsSync(join(out, "index.html"))) return out;
    mkdirSync(dirname(out), { recursive: true });
    const { bundle } = await import(require.resolve("@remotion/bundler"));
    const alias = {
      react: dirname(require.resolve("react/package.json")),
      "react-dom": dirname(require.resolve("react-dom/package.json")),
      remotion: dirname(require.resolve("remotion/package.json")),
    };
    const t0 = Date.now();
    await bundle({
      entryPoint: join(HERE, "entry.tsx"),
      outDir: out,
      webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, alias: { ...(c.resolve?.alias || {}), ...alias } } }),
    });
    console.log(`  [shots] 模板打包 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return out;
  })();
  bundlePromise.catch(() => {
    bundlePromise = null;
  });
  return bundlePromise;
}

async function comp(serveUrl, inputProps, id = "Beat") {
  const { selectComposition } = await import(require.resolve("@remotion/renderer"));
  return selectComposition({ serveUrl, id, inputProps });
}

/** 渲一拍:props = {theme, W, H, shots:[{tpl,p,from,frames,cues}], frames} */
export async function renderBeat(props, out, { workRoot, onProgress } = {}) {
  const serveUrl = await getBundle(workRoot);
  const { renderMedia } = await import(require.resolve("@remotion/renderer"));
  const composition = await comp(serveUrl, props);
  await renderMedia({
    serveUrl,
    composition,
    inputProps: props,
    codec: "h264",
    crf: 18,
    pixelFormat: "yuv420p",
    outputLocation: out,
    muted: true,
    chromiumOptions: { gl: "angle" },
    onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
  });
  return out;
}

/** 渲一张静帧(素材阶段的缩略图、网格用) */
export async function renderBeatStill(props, frame, out, { workRoot } = {}) {
  const serveUrl = await getBundle(workRoot);
  const { renderStill } = await import(require.resolve("@remotion/renderer"));
  const composition = await comp(serveUrl, props);
  await renderStill({ serveUrl, composition, inputProps: props, frame: Math.max(0, Math.min(composition.durationInFrames - 1, frame)), output: out, imageFormat: "png" });
  return out;
}

/**
 * 素材推镜:src 是 ffmpeg 已经处理好时长和进画的 W×H 片段(或图片),keys = [{f, z, cx, cy}](cx/cy 为 0-1)。
 * 素材临时放进打包目录的 public/ 里(Remotion 只从那儿读本地文件),渲完就删。
 */
export async function renderCam({ srcPath, kind = "video", keys, W, H, frames, fps = 30 }, out, { workRoot } = {}) {
  const serveUrl = await getBundle(workRoot);
  const { renderMedia } = await import(require.resolve("@remotion/renderer"));
  const { copyFileSync, rmSync } = await import("node:fs");
  const ext = kind === "video" ? "mp4" : srcPath.split(".").pop();
  const name = `cam/${createHash("sha1").update(srcPath + Date.now()).digest("hex").slice(0, 12)}.${ext}`;
  mkdirSync(join(serveUrl, "public", "cam"), { recursive: true });
  const staged = join(serveUrl, "public", name);
  copyFileSync(srcPath, staged);
  try {
    const props = { src: name, kind, W, H, frames, keys };
    const composition = await comp(serveUrl, props, "Cam");
    await renderMedia({ serveUrl, composition, inputProps: props, codec: "h264", crf: 18, pixelFormat: "yuv420p", outputLocation: out, muted: true, chromiumOptions: { gl: "angle" } });
  } finally {
    rmSync(staged, { force: true });
  }
  void fps;
  return out;
}
