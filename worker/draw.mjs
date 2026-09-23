// 手绘图解(学 MuseDock 的「白底手写图解」,落墨程序拷自它,见 worker/py/whiteboard/PROVENANCE.md)。
// 和它不同的两点:
// 1) 不用生图模型 —— 拿我们自己设计好的关系图/流程卡,用手写体渲成手绘风格,字一定对
//    (伤官、七杀这种字生图模型经常写错,MuseDock 为此还要再让视觉模型逐字核对);
// 2) 每一块什么时候开始画,按 MiniMax 逐字时间戳"念到它"的时刻定,不是按权重均分。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSketchCard, HAND_FONT } from "./cards.mjs";
import { planReveal } from "./reveal.mjs";
import { cached, keyOf } from "./segcache.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.DRAW_PYTHON || join(HERE, "py", ".venv", "bin", "python");
const FFMPEG = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
const FPS = 30;

export const DRAWABLE = new Set(["diagram", "flow"]);

export function drawReady() {
  return existsSync(PYTHON) && existsSync(HAND_FONT);
}

// 画的顺序:标签/标题先,然后按内容顺序,关系箭头画在它指向的那一项之前,结论最后
function drawOrder(card) {
  const t = card.type;
  const head = ["kicker", "title"];
  if (t === "diagram") {
    const n = (card.nodes || []).length;
    return [...head, ...Array.from({ length: n }, (_, i) => (i ? [`edge${i - 1}`, `node${i}`] : [`node${i}`])).flat(), "sub"];
  }
  if (t === "flow") {
    const n = (card.steps || []).length;
    return [...head, ...Array.from({ length: n }, (_, i) => (i ? [`arrow${i - 1}`, `step${i}`] : [`step${i}`])).flat(), "sub"];
  }
  if (t === "table") return [...head, "thead", ...(card.rows || []).map((_, i) => `row${i}`), "sub"];
  if (t === "contrast") return ["kicker", "sideL", "vs", "sideR", "sub"];
  return ["kicker", "qmark", "stepno", "title", "bar", "sub"];
}

// 每一块的开始时间(秒):优先用"念到它"的时刻;箭头紧挨着它指向的那一项之前
function startTimes(order, card, words, beatDur) {
  const plan = planReveal(card, words, Math.max(beatDur, 6.01)); // 短拍也按念到的时间排,只是整体压缩
  const items = plan.delays.items || {};
  const t = {};
  t.kicker = 0.05;
  t.title = 0.3;
  for (const k of order) {
    if (items[k] != null) t[k] = items[k];
    const m = k.match(/^(edge|arrow)(\d+)$/);
    if (m) {
      const next = `${m[1] === "edge" ? "node" : "step"}${Number(m[2]) + 1}`;
      if (items[next] != null) t[k] = Math.max(0, items[next] - 0.45);
    }
  }
  if (plan.delays.sub != null) t.sub = plan.delays.sub;
  if (t.thead == null) t.thead = 0.6;
  return { t, plan };
}

/**
 * 渲一段手绘图解视频,长度正好 segDur。返回 { path, decisions, cues, coverage, reused }。
 */
export async function drawCard({ card, size, words, beatDur, segDur, dir, beat }) {
  const order = drawOrder(card);
  const { t, plan } = startTimes(order, card, words, beatDur);
  const png = join(dir, `sketch-${beat}.png`);
  const out = join(dir, `drawn-${beat}.mp4`);
  const content = { ...card };
  delete content.anim;
  delete content.layout;
  const r = await cached(out, { kind: "drawn", content, size, words: words?.length ?? 0, t, segDur: Math.round(segDur * 1000), fps: FPS }, async (tmp) => {
    const { regions } = await renderSketchCard(content, size, png, order);
    // 按开始时间排好,首尾相接(落墨程序要求不重叠);每块最少 0.15s、最多 2.2s,
    // 画完留至少 0.8s 让人看全貌
    const endAll = Math.max(1.5, beatDur - 0.8);
    const timed = regions
      .map((rg) => ({ ...rg, start: Math.min(endAll - 0.2, t[rg.key] ?? endAll - 0.4) }))
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    const elements = timed.map((rg, i) => {
      const start = Math.max(cursor, rg.start);
      const nextStart = i + 1 < timed.length ? Math.max(start + 0.15, timed[i + 1].start) : endAll;
      // 小块(标签、箭头)画得快,大块(整个节点框、表格行)慢一点;不然一个小标签会被拖成两秒
      const areaShare = (rg.width * rg.height) / (size.width * size.height);
      const maxDur = Math.min(2.2, 0.5 + areaShare * 14);
      const dur = Math.max(0.15, Math.min(maxDur, nextStart - start - 0.02));
      cursor = start + dur + 0.02;
      return {
        id: rg.key,
        region: { x: rg.x, y: rg.y, width: rg.width, height: rg.height },
        reveal: { startMs: Math.round(start * 1000), durationMs: Math.round(dur * 1000), direction: "left-to-right", protectedRegions: [] },
      };
    });
    const job = {
      image: png,
      output: tmp,
      ffmpeg: FFMPEG,
      fps: FPS,
      durationMs: Math.round(segDur * 1000),
      frameCount: Math.ceil(segDur * FPS),
      showHand: true,
      annotation: {
        canvas: { width: size.width, height: size.height },
        rendering: {
          contractVersion: "whiteboard-handwritten-render-v1",
          canvasHex: "#FFFFFF",
          matchBackground: false,
          inkMode: "source-color",
          inkWeight: 4,
          colorWeight: 1,
          inkRevealRadius: 3,
          skeletonMinPoints: 4,
          skeletonResampleSpacing: 2.5,
        },
        elements,
      },
    };
    const res = await runPython(job);
    return { coverage: res.coverage, elements: elements.map((e) => ({ id: e.id, start: e.reveal.startMs / 1000, dur: e.reveal.durationMs / 1000 })) };
  });
  const meta = r.meta;
  const matched = plan.cues.filter((c) => c.matched).length;
  const decisions = [
    {
      beat,
      topic: "手绘",
      choice: `手绘图解,${meta.elements?.length ?? "?"} 块按念到的顺序一笔笔画出来`,
      why: `${matched}/${plan.cues.length} 项对上了台词里念到它的时刻,其余夹在中间排开;字是手写体渲出来的,不经过生图模型,一定不会写错`,
      key: "draw",
      value: "on",
    },
  ];
  if (meta.coverage != null && meta.coverage < 0.97) {
    decisions.push({ beat, topic: "手绘", choice: `有 ${((1 - meta.coverage) * 100).toFixed(1)}% 的笔迹不在任何一块里`, why: "这部分画不出来(不会在最后突然冒出来),多半是卡片的装饰线", warn: true });
  }
  return { path: out, decisions, cues: plan.cues, elements: meta.elements || [], reused: r.reused, key: keyOf({ out, meta }) };
}

function runPython(job) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [join(HERE, "py", "draw.py")], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const killer = setTimeout(() => p.kill("SIGKILL"), 15 * 60 * 1000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(killer);
      reject(new Error(`手绘程序没启动起来:${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(killer);
      const last = out.trim().split("\n").at(-1) || "{}";
      let j = {};
      try {
        j = JSON.parse(last);
      } catch {
        /* 下面报错 */
      }
      if (code === 0 && j.ok) resolve(j);
      else reject(new Error(`手绘渲染失败:${j.error || err.trim().split("\n").at(-1) || `退出码 ${code}`}`));
    });
    p.stdin.end(JSON.stringify(job));
  });
}
