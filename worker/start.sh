#!/bin/bash
# reelforge render worker — secrets injected from the encrypted store, never printed.
# pm2: pm2 start worker/start.sh --name reelforge-worker
cd "$(dirname "$0")/.." || exit 1
export BOARD_URL="${BOARD_URL:-https://reelforge.jessylab.cc}"
exec secret exec REELFORGE_WORKER_TOKEN OPENROUTER_API_KEY_REELFORGE MINIMAX_API_KEY -- bash -c '
  export WORKER_TOKEN="$REELFORGE_WORKER_TOKEN" OPENROUTER_API_KEY="$OPENROUTER_API_KEY_REELFORGE"
  exec node worker/index.mjs'
