# reelforge

**内容生产监管台** — a standalone product for **agent-driven Douyin short-video production**.
A background **hermit agent** works each pipeline step meticulously; you review/approve on a web 监管台; on final approval it auto-generates the vertical cover + Douyin caption and packages everything for download.

> Learns from **hermit-ui**'s patterns (its `Interaction` review-gate model, Next.js + tRPC + Prisma + Tailwind stack, sidebar shell, `x-asst-key` client auth). It is a **separate product** — it does not modify or import hermit-ui.

## Core idea

The pipeline is a **state machine with a human review gate per stage**:

```
选题 → 脚本 → 素材 → 配音 → 剪辑 → 字幕 → 润色 → 交付
                                 ▲
                    each stage stops at `awaiting_review`
                    → you 通过 / 批注(指到具体段) / 打回 on the web
                    agent picks up your notes and continues
```

Not about speed — about **async autonomy + meticulous craft per step + your oversight**. The agent self-polishes to the taste playbook before you ever look; your judgment (and ear) stays the final gate.

## Stack

- Next.js (App Router, TS) + Tailwind v4 (CSS-var tokens) + Prisma (SQLite `dev.db`)
- Route Handlers for the API (v0; tRPC parity is a roadmap item)
- `Project` / `Stage` domain model — `Stage.status = awaiting_review` is the review gate
- Media served (Range-supported) from local file paths so drafts play in the browser
- Delivery = zip of video + vertical cover + `caption.txt`

## Run

```bash
pnpm install
pnpm prisma generate
pnpm db:push        # create the SQLite schema
pnpm db:seed        # seed the real paper-benchmark project (a video that actually plays)
pnpm dev            # http://localhost:3000
```

## The taste playbook (what the agent self-reviews against)

真素材不吹（Jessy 是论文一作，数字用原值）· auramate 系列**不要 BGM** · 第一人称她的克隆音 · **开头要炸、别娓娓道来**（配音要激情）· 钩子第一句定主旨 · 找来的外网切片带原声+字幕解释 · 封面**爆款风**（巨字+戏剧图，非学术）· 每句配"说什么显什么"的画面 · 平台=抖音竖版优先。

## Roadmap

1. **Real pipeline integration** — wire the existing render (Playwright HTML cards) / voice (MiniMax clone `jessy1777965074473`) / build (ffmpeg) / codex vertical-cover / subtitle scripts (currently ad-hoc in `ops-bilibili/projects/*`) into callable reelforge modules behind `lib/deliver.ts` + the stage runners.
2. **The hermit-agent worker** (`lib/agent.ts`) — a real `reelforge-worker` hermit agent (same framework as this whole system, `~/asst`) that advances stages and posts artifacts back, orchestrated like hermit-ui's gateway (tmux-managed agents).
3. **Remote access** — expose to her phone via a tunnel through her server (`8.216.48.63`, rathole) or deploy there.
4. **Traffic feedback loop** — she reports each published clip's Douyin metrics → a tracking table → analysis of which topics/hooks/lengths drive views → feeds back into topic-picking + editing.

## Status: v0

Dashboard + per-stage review gates + auto cover/caption/package on approval, seeded with one real project (the AI-算命 benchmark video, which plays in the edit stage). The worker orchestration + real generators are stubbed with clear TODO hooks.
