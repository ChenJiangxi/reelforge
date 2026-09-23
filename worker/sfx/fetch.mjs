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
  const r = await fetch(it.download_url);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok || sha(buf) !== it.sha256) throw new Error(`${it.file} 下载失败或校验不对(HTTP ${r.status})`);
  writeFileSync(out, buf);
  console.log(`下载 ${it.file}`);
}
console.log("音效就绪");
