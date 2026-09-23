// 按内容缓存渲染结果(学 MuseDock frameRenderPhase 的 attestation):
// key = 所有会影响输出的输入(素材文件的字节哈希、时长、分辨率、参数、覆盖、渲染配方版本),
// 旁边存一份 .json(key + 输出大小 + 当时的决定清单)。key 一样、文件还在、大小对得上才复用。
// 改了一拍的参数,只有那一拍重渲,其余拍直接拿上次的结果 —— 以前每次重剪 12 拍全渲一遍。
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync, statSync, renameSync, rmSync } from "node:fs";

// 改了进画/运镜/编码参数这些"配方",就把版本号 +1,旧缓存全部自动失效
export const RECIPE_VERSION = "2026-09-23.1";

const shaMemo = new Map(); // path+mtime+size → sha,同一次运行里别反复读大文件

export async function fileSha(p) {
  const st = statSync(p);
  const memoKey = `${p}|${st.mtimeMs}|${st.size}`;
  if (shaMemo.has(memoKey)) return shaMemo.get(memoKey);
  const sha = await new Promise((resolve, reject) => {
    const h = createHash("sha1");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
  shaMemo.set(memoKey, sha);
  return sha;
}

export function keyOf(parts) {
  return createHash("sha1").update(JSON.stringify({ v: RECIPE_VERSION, ...parts })).digest("hex");
}

/**
 * out:最终文件路径。render(tmpPath) 负责把结果写到 tmpPath,返回要一起缓存的 meta(比如决定清单)。
 * 返回 { reused, meta }。
 */
export async function cached(out, parts, render) {
  const key = keyOf(parts);
  const side = `${out}.json`;
  if (existsSync(out) && existsSync(side)) {
    try {
      const m = JSON.parse(readFileSync(side, "utf8"));
      if (m.key === key && m.size > 0 && statSync(out).size === m.size) return { reused: true, meta: m.meta ?? {} };
    } catch {
      /* 坏的旁注文件当作没缓存 */
    }
  }
  const ext = out.match(/\.[a-z0-9]+$/i)?.[0] ?? "";
  const tmp = `${out.slice(0, out.length - ext.length)}.tmp${ext}`;
  rmSync(tmp, { force: true });
  const meta = (await render(tmp)) ?? {};
  renameSync(tmp, out); // 写完再改名:渲到一半挂掉不会留下一个"看起来能用"的坏文件
  writeFileSync(side, JSON.stringify({ key, size: statSync(out).size, meta }));
  return { reused: false, meta };
}
