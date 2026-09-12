#!/bin/bash
# reelforge 一键部署。默认增量(只换 .next 编译产物,<1MB,约 1 分钟);
# 改了依赖 / prisma schema / next.config 时用 ./deploy.sh --full(整包 60MB,约 30-40 分钟)。
# 服务器(1.6G 小机)零构建零安装。
set -e
cd "$(dirname "$0")"
KEY="$HOME/.ssh/reelforge_ed25519"
HOST=root@8.216.48.63

echo "[1/3] build"
pnpm build > /tmp/rf-build.log 2>&1 || { tail -20 /tmp/rf-build.log; exit 1; }
cp -r .next/static .next/standalone/.next/static

if [ "$1" = "--full" ]; then
  echo "[2/3] full pack (60MB,慢)"
  # 注意:exclude 必须锚定顶层(./worker)——裸写 worker 会误杀 .next/server/app/api/worker/ 路由
  tar czf /tmp/rf-deploy.tgz -C .next/standalone --exclude "./data" --exclude "./prisma/dev.db*" --exclude "./worker" .
  EXTRACT='cp -a /opt/reelforge/app /opt/reelforge/app.bak 2>/dev/null || true; rm -rf /opt/reelforge/app; mkdir -p /opt/reelforge/app; tar xzf /tmp/rf-deploy.tgz -C /opt/reelforge/app'
else
  echo "[2/3] delta pack (.next only)"
  tar czf /tmp/rf-deploy.tgz -C .next/standalone .next package.json
  EXTRACT='cd /opt/reelforge/app; rm -rf .next.bak; cp -a .next .next.bak 2>/dev/null || true; rm -rf .next; tar xzf /tmp/rf-deploy.tgz'
fi
ls -la /tmp/rf-deploy.tgz | awk '{printf "  %.1f MB\n", $5/1048576}'

echo "[3/3] upload + restart"
scp -i "$KEY" /tmp/rf-deploy.tgz "$HOST:/tmp/"
rm /tmp/rf-deploy.tgz
ssh -i "$KEY" "$HOST" "
  set -e
  $EXTRACT
  rm -f /tmp/rf-deploy.tgz
  systemctl restart reelforge.service
  sleep 4
  systemctl is-active reelforge.service
  curl -s -o /dev/null -w 'local http: %{http_code}\n' http://127.0.0.1:3001/login
"
echo "DEPLOYED https://reelforge.jessylab.cc"
