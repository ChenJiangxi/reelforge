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

// Uploads go over a slow international link (tens of KB/s); use raw http with
// a 15-minute timeout and retries — undici's fetch defaults give up mid-file.
export async function upload(projectId, absPath, name, attempt = 1) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(absPath);
  const fname = name || absPath.split("/").pop();
  const boundary = "----rf" + Date.now().toString(36);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="projectId"\r\n\r\n${projectId}\r\n` +
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
          try { resolve(JSON.parse(body)); } catch { reject(new Error("upload: bad json")); }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("upload timeout")));
    req.on("error", reject);
    req.write(head);
    req.write(buf);
    req.end(tail);
  });

  try {
    return await doOnce();
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 15000 * attempt));
      return upload(projectId, absPath, name, attempt + 1);
    }
    throw e;
  }
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
