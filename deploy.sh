#!/bin/bash
# reelforge 一键部署:本机构建 standalone → 打包上传 → 服务器解压重启。
# 服务器(1.6G 小机)零构建零安装。用法:./deploy.sh
set -e
cd "$(dirname "$0")"
KEY="$HOME/.ssh/reelforge_ed25519"
HOST=root@8.216.48.63

echo "[1/4] build"
pnpm build > /tmp/rf-build.log 2>&1 || { tail -20 /tmp/rf-build.log; exit 1; }
cp -r .next/static .next/standalone/.next/static

echo "[2/4] pack"
# 注意:exclude 必须锚定顶层(./worker)——裸写 worker 会误杀 .next/server/app/api/worker/ 路由
tar czf /tmp/rf-standalone.tgz -C .next/standalone --exclude "./data" --exclude "./prisma/dev.db*" --exclude "./worker" .
ls -la /tmp/rf-standalone.tgz | awk '{printf "  %.1f MB\n", $5/1048576}'

echo "[3/4] upload + extract (国际链路慢,60MB 约 20-40 分钟)"
scp -i "$KEY" /tmp/rf-standalone.tgz "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" '
  set -e
  cp -a /opt/reelforge/app /opt/reelforge/app.bak 2>/dev/null || true
  rm -rf /opt/reelforge/app
  mkdir -p /opt/reelforge/app
  tar xzf /tmp/rf-standalone.tgz -C /opt/reelforge/app
  rm /tmp/rf-standalone.tgz
'
rm /tmp/rf-standalone.tgz

echo "[4/4] restart + health"
ssh -i "$KEY" "$HOST" '
  set -e
  systemctl daemon-reload
  systemctl restart reelforge.service
  sleep 4
  systemctl is-active reelforge.service
  curl -s -o /dev/null -w "local http: %{http_code}\n" http://127.0.0.1:3001/login
' || { echo "FAILED — 回滚: ssh $HOST \"rm -rf /opt/reelforge/app && mv /opt/reelforge/app.bak /opt/reelforge/app && systemctl restart reelforge.service\""; exit 1; }
echo "DEPLOYED https://reelforge.jessylab.cc"
