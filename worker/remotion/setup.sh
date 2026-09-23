#!/bin/bash
# 镜头渲染器(Remotion)的依赖。worker 机器第一次跑一次;没装的话素材阶段退回老字卡。
# 第一次渲染时 Remotion 会自己下载一个 Chrome Headless Shell(约 90MB)。
set -e
cd "$(dirname "$0")"
NODE_ENV=development npm install --no-audit --no-fund
echo "ok: $(du -sh node_modules | cut -f1)"
