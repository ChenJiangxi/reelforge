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
import { STAGES } from "./stages.mjs";

const POLL_MS = Number(process.env.POLL_MS || 15000);
const MAX_CONC = Number(process.env.MAX_CONC || 1);
const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS || 45 * 60 * 1000);

const inflight = new Map(); // stageId -> startedAt

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
  }
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
    // A stage that already FAILED once stays parked until a human rejects it
    // with a fresh note (rejects always carry a comment).
    const failed = item.status === "changes_requested" && !item.comment
      && String(item.artifacts?.note || "").startsWith("FAILED:");
    if (failed) continue;

    inflight.set(item.stageId, Date.now());
    (async () => {
      try {
        await claim(item.stageId);
        log(`CLAIM "${item.title}" /${item.kind} (${item.stageId})`);
        const artifacts = await runItem(item);
        await submit(item.stageId, "awaiting_review", artifacts);
        log(`DONE  "${item.title}" /${item.kind} -> awaiting_review`);
      } catch (e) {
        log(`FAIL  "${item.title}" /${item.kind}: ${e.message}`);
        try {
          await submit(item.stageId, "changes_requested", { note: `FAILED: ${e.message}` });
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
