#!/bin/bash
# reelforge render worker — secrets injected from the encrypted store, never printed.
# pm2: pm2 start worker/start.sh --name reelforge-worker
# LLM 用本机 Claude(worker/claude.mjs,走这台机器登录的订阅),不再需要 OpenRouter 的 key。
cd "$(dirname "$0")/.." || exit 1
export BOARD_URL="${BOARD_URL:-https://reelforge.jessylab.cc}"
exec secret exec REELFORGE_WORKER_TOKEN MINIMAX_API_KEY -- bash -c '
  export WORKER_TOKEN="$REELFORGE_WORKER_TOKEN"
  exec node worker/index.mjs'
