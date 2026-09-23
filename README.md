# reelforge

输入一个主题,AI 把一条抖音/小红书/B站口播短视频从选题做到交付;每一步停在审核门等人看。
线上:<https://reelforge.jessylab.cc>(共享口令登录)。

```
选题 → 脚本 → 素材 → 配音 → 剪辑 → 字幕 → 润色 → 交付
 每一步做完停在「待你审」:通过 / 打回(写批注,worker 照着改) / 重做某一步
```

## 三个核心设计

**每个决定写在脸上。** 每个阶段交产物时同时交一份 `decisions`(`lib/stages.ts` 的 `Decision`):
这一步替人做了哪些决定、为什么。网页上摆在成片旁边(`components/DecisionList.tsx`),按拍分组,
该注意的标黄。例:`c01 素材 1080×1440(3:4)→ 画面 1080×1920(9:16),铺满会裁掉左右各 12.5%,所以整幅放进去`。

**直接指挥某一拍。** 聊天里说「c01 别裁,慢一点」「c10 从20秒开始」,不经过 LLM,直接变成挂在那一拍上的
剪辑参数覆盖(脚本阶段 `clips[i].overrides`:进画 / 速度 / 不够长时怎么补 / 起点 / 运镜),持久、可撤销,
只重跑剪辑。解析器是 `lib/direct-edit.ts`,写入是 `lib/overrides.ts`;决定清单里的剪辑决定点开也能改。

**重跑是勾的,不是猜的。** 依赖只有一张表(`lib/stages.ts` 的 `DEPS`,分 hard / soft);打回、重做、重试、
聊天改稿、拖素材、换配音版本、参数覆盖全部走 `lib/rerun.ts` 的 `requeue()`。重做前弹一张表:锁死的、
可取消的、不受影响的各自写明原因。聊天里"重做 XX"只打开这张表,不直接执行。

## 架构

| 部分 | 在哪 | 做什么 |
|---|---|---|
| 网页 + API | 服务器 `8.216.48.63`,`/opt/reelforge/app`,systemd `reelforge.service`,nginx → `127.0.0.1:3001` | Next.js 16 standalone + Prisma(SQLite `/opt/reelforge/data/reelforge.db`);媒体在 `/opt/reelforge/media`,只经 `/api/media/` 读盘返回 |
| 渲染 worker | macmini,pm2 `reelforge-worker`(`worker/start.sh`) | 轮询 `/api/worker/poll` 认领阶段,LLM(OpenRouter deepseek-v3.2)写字、MiniMax 配音、Playwright 渲卡、ffmpeg 剪辑,产物经 `/api/worker/upload` 传回 |

- worker 每步调 `mark(item, beat, step)`:失败时说清卡在哪一拍哪一步;也是取消点 —— 阶段被重新排队或超时,
  下一步开始前就停(`/api/worker/status`)。
- 开工前查磁盘水位(`worker/index.mjs` `NEED_GB`,`DISK_RESERVE_GB` 可再加),不够就停下说明,空间回来自动接着做。
- 媒体和教案接口只认登录 cookie 或 worker 的 Bearer token;路径一律经 `lib/media.ts` 的 `mediaPath()` 校验。
- 素材链接带 `?v=<修改时间>`,worker 按链接缓存 —— 同名文件重新上传后一定会重新下载。

## 目录

```
app/                 页面 + API(api/worker/* 给 worker,其余过口令)
components/          PreviewPane(阶段查看器)、DecisionList、RerunForm、ChatPanel …
lib/stages.ts        阶段顺序、依赖表、决定/覆盖/失败的类型
lib/rerun.ts         唯一的重跑入口 requeue()
lib/resolve-stage.ts 审核门:通过 / 批注 / 打回;全部通过时(重新)打包
lib/deliver.ts       打包 zip(成片 + 封面 + 文案)
worker/stages.mjs    八个阶段的执行器
worker/prompts.mjs   提示词;教案(/playbooks 页在线改)每 60 秒从服务器拉一次
```

## 本地开发

```bash
NODE_ENV=development pnpm install   # 这台机器默认 NODE_ENV=production,会跳过 devDependencies
npx prisma generate
pnpm build && pnpm start            # 验证交互用 build+start,dev 模式页面不 hydrate
```

在生产数据副本上端到端跑一遍(不碰线上)的做法见 agent 的 `reelforge-local-e2e` skill。

## 部署

```bash
./deploy.sh          # 增量:只换 .next,约 1 分钟
./deploy.sh --full   # 依赖 / prisma schema / next.config 变了才用,约 30-40 分钟
pm2 restart reelforge-worker   # worker 代码改了;worker 不用部署
```

schema 变了除了 `--full`,还要把新生成的 `@prisma/client` 同步到服务器,再 `prisma db push`。
