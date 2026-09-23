// 把音效文件取到本机(worker/sfx/*.wav,不进仓库):本机有 MuseDock 仓库就直接拷,没有就从 Mixkit 下载,
// 都按清单里的 sha256 校验。用法:node worker/sfx/fetch.mjs [MuseDock 仓库路径]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const lib = JSON.parse(readFileSync(join(HERE, "library.json"), "utf8"));
const local = process.argv[2] || "/Users/macmini003/chatcut-dev/projects/musedock-ref";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
for (const it of lib.items) {
  const out = join(HERE, it.file);
  if (existsSync(out) && sha(readFileSync(out)) === it.sha256) continue;
  const tag = it.tags?.[0];
  const src = join(local, "assets", "sfx", "mixkit", tag || "", it.file);
  if (existsSync(src) && sha(readFileSync(src)) === it.sha256) {
    copyFileSync(src, out);
    console.log(`拷贝 ${it.file}`);
    continue;
  }
  let buf = null;
  let status = 0;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const r = await fetch(it.download_url, { signal: AbortSignal.timeout(60_000) });
      status = r.status;
      const b = Buffer.from(await r.arrayBuffer());
      if (r.ok && sha(b) === it.sha256) buf = b;
    } catch {
      /* 网络抖一下再试 */
    }
    if (!buf) await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
  if (!buf) throw new Error(`${it.file} 下载三次都失败或校验不对(HTTP ${status})`);
  writeFileSync(out, buf);
  console.log(`下载 ${it.file}`);
}
console.log("音效就绪");
