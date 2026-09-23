// Thin client for the reelforge board API (server side of the product).
import https from "node:https";
import http from "node:http";

const BOARD = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN || "";

function isNetErr(e) {
  return e && (e.message === "fetch failed" || e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "EPIPE");
}

async function api(path, opts = {}, attempt = 1) {
  try {
    const r = await fetch(BOARD + path, {
      ...opts,
      headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${r.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  } catch (e) {
    if (isNetErr(e) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 10000 * attempt));
      return api(path, opts, attempt + 1);
    }
    throw e;
  }
}

export const poll = () => api("/api/worker/poll");
export const claim = (stageId) =>
  api("/api/worker/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageId }) });
export const submit = (stageId, status, artifacts) =>
  api("/api/worker/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageId, status, artifacts }) });
export const resetWorking = () => api("/api/worker/reset", { method: "POST" });
export const heartbeat = (body) =>
  api("/api/worker/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 4);
export const postCalls = (records) =>
  api("/api/worker/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ records }) }, 3);
/** { stageId: status } —— worker 用来发现手上的阶段被重新排队了 */
export const stageStatus = (ids) => api(`/api/worker/status?ids=${ids.map(encodeURIComponent).join(",")}`, {}, 4);

// Uploads go over a slow international link (tens of KB/s); use raw http with
// a 15-minute timeout and retries — undici's fetch defaults give up mid-file.
// onProgress(sent, total):分块写,每写一块报一次 —— 页面上显示"上传成片 60%"
// fields:额外的表单字段,比如 {into:"assets"} 直接放进素材库
export async function upload(projectId, absPath, name, attempt = 1, onProgress = null, fields = {}) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(absPath);
  const fname = name || absPath.split("/").pop();
  const boundary = "----rf" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}\r\n` +
    Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const url = new URL(BOARD + "/api/worker/upload");
  const mod = url.protocol === "https:" ? https : http;

  const doOnce = () => new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": head.length + buf.length + tail.length,
        },
        timeout: 8 * 60 * 1000, // 1MB 卡正常 20s;8min 只对真卡死兜底,别躺 15min
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`upload -> ${res.statusCode}: ${body.slice(0, 200)}`));
          try {
            const j = JSON.parse(body);
            if (j.url) j.url += `?v=${Date.now()}`; // 同名覆盖后,URL 必须变,浏览器才不会拿旧缓存
            resolve(j);
          } catch { reject(new Error("upload: bad json")); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("upload timeout")));
    req.on("error", reject);
    req.write(head);
    // 分块写:网络慢的时候按 drain 节奏走,顺便知道传了多少
    const CHUNK = 256 * 1024;
    let off = 0;
    const pump = () => {
      while (off < buf.length) {
        const end = Math.min(buf.length, off + CHUNK);
        const ok = req.write(buf.subarray(off, end));
        off = end;
        onProgress?.(off, buf.length);
        if (!ok) {
          req.once("drain", pump);
          return;
        }
      }
      req.end(tail);
    };
    pump();
  });

  try {
    return await doOnce();
  } catch (e) {
    if (attempt < 4 && !/-> 507/.test(String(e.message))) {
      await new Promise((r) => setTimeout(r, 15000 * attempt));
      return upload(projectId, absPath, name, attempt + 1, onProgress, fields);
    }
    throw e;
  }
}

// 上游产物按 URL 缓存,不按文件名。这套管线里同名覆盖是常态 —— 卡重渲、粗剪重出
// 都写回同一个名字,URL 只有 ?v=<时间戳> 在变。只判断"文件在不在"的话,下游会默默
// 吃一个几天前的旧文件而且毫无报错:2026-09-16 字幕阶段就是这样,在 09-13 的粗剪
// (还带着 SAR 14:3 的坏标签和别的项目的故事板拼图)上烧了三天字幕。
export async function downloadCached(urlPath, dest) {
  const { createHash } = await import("node:crypto");
  const tag = createHash("sha1").update(String(urlPath)).digest("hex").slice(0, 8);
  const i = dest.lastIndexOf(".");
  const real = i > dest.lastIndexOf("/") ? `${dest.slice(0, i)}-${tag}${dest.slice(i)}` : `${dest}-${tag}`;
  const { existsSync } = await import("node:fs");
  if (!existsSync(real)) await download(urlPath, real);
  return real;
}

export async function download(urlPath, dest) {
  const r = await fetch(BOARD + urlPath, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`download ${urlPath} -> ${r.status}`);
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}
