#!/usr/bin/env node
// reelforge render worker — polls the board, claims one claimable stage at a
// time (heavy ffmpeg/Playwright work, serial by default), executes it with a
// deterministic pipeline (DeepSeek for words, MiniMax for voice, ffmpeg for
// the cut), pushes artifacts back for human review.
//
// Required env: BOARD_URL, WORKER_TOKEN, OPENROUTER_API_KEY, MINIMAX_API_KEY
// Run via: secret exec OPENROUTER_API_KEY_REELFORGE MINIMAX_API_KEY -- \
//   env OPENROUTER_API_KEY=$OPENROUTER_API_KEY_REELFORGE node worker/index.mjs
import { poll, claim, submit, resetWorking } from "./board.mjs";
import { STAGES, WORK_ROOT } from "./stages.mjs";
import { freeGB } from "./ffmpeg.mjs";
import { loadPlaybooks } from "./prompts.mjs";

const POLL_MS = Number(process.env.POLL_MS || 15000);
const MAX_CONC = Number(process.env.MAX_CONC || 1);
const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS || 45 * 60 * 1000);
const PLAYBOOK_REFRESH_MS = 60000;

const inflight = new Map(); // stageId -> startedAt

// 开工前的磁盘水位(GB):剪辑/字幕要写十几段中间视频,留足;其余阶段小。
// 不够就不开工,直接告诉她是磁盘 —— 以前是渲到一半 ENOSPC,报一串看不懂的 ffmpeg 错。
const NEED_GB = { footage: 1, voice: 0.5, edit: 2, subtitles: 2, polish: 1, deliver: 0.3, topic: 0.1, script: 0.1 };
// DISK_RESERVE_GB:机器上还跑着别的东西时,给它们再留一块(默认 0)
const LABEL = { topic: "选题", script: "脚本", footage: "素材", voice: "配音", edit: "剪辑", subtitles: "字幕", polish: "润色", deliver: "交付" };
const needGB = (kind) => (NEED_GB[kind] ?? 0.5) + Number(process.env.DISK_RESERVE_GB || 0);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms / 60000}min (${label})`)), ms)),
  ]);
}

async function runItem(item) {
  const handler = STAGES[item.kind];
  if (!handler) throw new Error(`unknown stage kind ${item.kind}`);
  if (item.status === "changes_requested" && item.comment) {
    log(`  ↳ addressing review note: "${item.comment}"`);
    // Surface her note to the stage via the item so prompts can use it.
    item.reviewNote = item.comment;
  } else if (item.failed && item.artifacts?.failure?.note) {
    // 磁盘满失败后自动续跑:失败那次在处理的批注接着处理
    item.reviewNote = item.artifacts.failure.note;
  }
  // 每一步开始前 stages.mjs 会写 item.progress = { beat, step },失败/超时时据此说清卡在哪
  item.progress = {};
  return withTimeout(handler(item), STAGE_TIMEOUT_MS, item.kind);
}

async function tick() {
  if (inflight.size >= MAX_CONC) return;
  let items;
  try {
    items = await poll();
  } catch (e) {
    log(`poll failed: ${e.message}`);
    return;
  }
  for (const item of items) {
    if (inflight.size >= MAX_CONC) break;
    if (inflight.has(item.stageId)) continue;
    // 失败过的阶段停放,等她点「重试」。停放由服务端判(poll 的 failed:最后一条事件是失败);
    // 老服务端没有这个字段,退回原来的猜法。
    const failed = item.failed ?? (item.status === "changes_requested" && !item.comment
      && String(item.artifacts?.note || "").startsWith("FAILED:"));
    const free = freeGB(WORK_ROOT);
    const need = needGB(item.kind);
    if (failed) {
      // 唯一的例外:上次是开工前磁盘不够 —— 空间够了就自己接着做,不用等她
      if (!(item.artifacts?.failure?.kind === "disk" && free >= need)) continue;
      log(`RESUME "${item.title}" /${item.kind}: 磁盘现在有 ${free.toFixed(1)} GB,接着做`);
    } else if (free < need) {
      inflight.set(item.stageId, Date.now());
      try {
        await claim(item.stageId);
        const message = `渲染机磁盘只剩 ${free.toFixed(1)} GB,「${LABEL[item.kind] ?? item.kind}」开工至少要 ${need} GB,没开工`;
        log(`DISK  "${item.title}" /${item.kind}: ${message}`);
        await submit(item.stageId, "changes_requested", {
          note: `FAILED: ${message}`,
          failure: { stage: item.kind, step: "开工前检查磁盘", message, kind: "disk", ts: Date.now(), note: item.comment || undefined },
        });
      } catch (e) {
        log(`  ↳ disk-refusal submit failed: ${e.message}`);
      } finally {
        inflight.delete(item.stageId);
      }
      continue;
    }

    inflight.set(item.stageId, Date.now());
    (async () => {
      try {
        await claim(item.stageId);
        log(`CLAIM "${item.title}" /${item.kind} (${item.stageId})`);
        const artifacts = await runItem(item);
        await submit(item.stageId, "awaiting_review", artifacts);
        log(`DONE  "${item.title}" /${item.kind} -> awaiting_review`);
      } catch (e) {
        const p = item.progress || {};
        const where = [p.beat, p.step].filter(Boolean).join(" · ");
        const message = String(e?.message || e).slice(0, 400);
        log(`FAIL  "${item.title}" /${item.kind}${where ? ` [${where}]` : ""}: ${message}`);
        const failure = {
          stage: item.kind,
          beat: p.beat || undefined,
          step: p.step || undefined,
          message,
          kind: e?.disk ? "disk" : /^timeout after/.test(message) ? "timeout" : "error",
          ts: Date.now(),
          note: item.reviewNote || undefined, // 重试时接着处理这条批注
        };
        try {
          await submit(item.stageId, "changes_requested", { note: `FAILED: ${where ? `[${where}] ` : ""}${message}`, failure });
        } catch (e2) {
          log(`  ↳ could not mark failed: ${e2.message}`);
        }
      } finally {
        inflight.delete(item.stageId);
      }
    })();
  }
}

async function main() {
  log(`reelforge worker starting (board=${process.env.BOARD_URL || "http://localhost:3000"}, poll=${POLL_MS}ms, conc=${MAX_CONC})`);
  await loadPlaybooks().catch((e) => log(`playbooks load failed (local fallback): ${e.message}`));
  setInterval(() => loadPlaybooks().catch(() => {}), PLAYBOOK_REFRESH_MS);
  try {
    const r = await resetWorking();
    if (r.reset) log(`startup: reset ${r.reset} orphaned working stage(s)`);
  } catch (e) {
    log(`startup reset failed: ${e.message}`);
  }
  tick();
  setInterval(tick, POLL_MS);
}
main();
