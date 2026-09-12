// Thin client for the reelforge board API (server side of the product).
const BOARD = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN || "";

async function api(path, opts = {}) {
  const r = await fetch(BOARD + path, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${r.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

export const poll = () => api("/api/worker/poll");
export const claim = (stageId) =>
  api("/api/worker/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageId }) });
export const submit = (stageId, status, artifacts) =>
  api("/api/worker/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stageId, status, artifacts }) });
export const resetWorking = () => api("/api/worker/reset", { method: "POST" });

export async function upload(projectId, absPath, name) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(absPath);
  const form = new FormData();
  form.set("projectId", projectId);
  form.set("file", new Blob([buf]), name || absPath.split("/").pop());
  return api("/api/worker/upload", { method: "POST", body: form });
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
