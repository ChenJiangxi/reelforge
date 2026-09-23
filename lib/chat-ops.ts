// Chat → clip-level edit ops, parsed by DeepSeek on the server (cheap: ~1k tokens/msg).
// The video is a sequence of 分句 clips (大字卡 + 配音), so "对话剪辑" =
// natural-language ops on that clip list, then downstream stages regenerate.

import type { Overrides } from "@/lib/stages";

export type Say = { speed?: number; pitch?: number; emotion?: string; gap_after?: number };
export type Clip = {
  name: string; text: string; tts?: string; say?: Say; visual?: string; asset?: string;
  /** 画面简报被她改过几次 —— 素材阶段靠它判断"这拍的旧设计还能不能沿用"(光比台词,改画面会被忽略) */
  visualRev?: number;
  overrides?: Overrides;
};

export type ChatOp =
  | { action: "edit_text"; clip: string; text: string }
  | { action: "delete_clip"; clip: string }
  | { action: "insert_after"; clip: string; text: string; visual?: string }
  | { action: "edit_visual"; clip: string; visual: string }
  | { action: "edit_delivery"; clip: string; say: Say }
  | { action: "assign_asset"; clip: string; asset: string }
  | { action: "redo_stage"; kind: string; note: string }
  | { action: "review"; decision: "approve" | "reject"; note?: string }
  | { action: "reply"; text: string };

export type ParsedChat = { ops: ChatOp[]; reply: string };

const MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v3.2";

export async function parseChat(
  userText: string,
  clips: Clip[],
  project: { topic: string; title: string },
  awaiting?: { kind: string; label: string } | null,
  assets?: { name: string; kind: string }[],
  stateCtx?: string,
): Promise<ParsedChat> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ops: [], reply: "服务器还没配 LLM key,这条我先记下了,暂时没法自动改。" };
  }
  const clipList = clips.length
    ? clips.map((c) => `${c.name}: "${c.text}"(画面:${c.visual || "无"})`).join("\n")
    : "(还没有分句——脚本阶段还没产出)";
  const assetList = assets?.length
    ? `\n素材库(她上传的真素材):\n${assets.map((a) => `- "${a.name}"(${a.kind === "video" ? "录屏视频" : "图片"})`).join("\n")}\n她说"第N拍/第N句用XX录屏/图"时 → assign_asset。`
    : "";

  const awaitingBlock = awaiting
    ? `【当前状态:「${awaiting.label}」阶段正在等她审】
此时她的话先按这个判断:
- 满意/肯定(可以/过了/行/没问题/通过) → {"action":"review","decision":"approve"}
- 不满意/批评/要改(没激情/不行/换/这句不对/重做) → {"action":"review","decision":"reject","note":"把她的原话整理成给 agent 的修改指示"}
- 如果是针对其他阶段或片子的修改,仍走下面的普通操作。
review 操作优先于一切普通操作——她在审,不是在下新需求。`
    : "【当前状态:没有待审阶段】她的话都是普通修改或闲聊。";

  // 服务端调 LLM 也要有超时:挂住的连接会让她的聊天框一直转圈(worker 那边 09-13 吃过同样的亏)
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    signal: AbortSignal.timeout(60_000),
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: `你是视频剪辑助手。这条片是"分句口播视频":每句台词 = 一张大字卡 + 一段配音,按顺序拼接。
用户用自然语言提修改。把她的指令解析成操作列表。操作类型:
- {"action":"edit_text","clip":"c03","text":"新台词"} 改某句台词(会重新配音+重剪)
- {"action":"delete_clip","clip":"c04"} 删某句
- {"action":"insert_after","clip":"c04","text":"新句子","visual":"画面简报"} 在某句后插一句
- {"action":"edit_visual","clip":"c02","visual":"新画面简报"} 只改某句的画面卡
- {"action":"edit_delivery","clip":"c01","say":{"speed":1.2,"pitch":2,"emotion":"surprised","gap_after":0.1}} 只改某句"怎么念"
  (她说"第1拍快一点/开头再冲一点/这句慢下来压住/这里停一下"就用它,只重出配音,画面不动)
  speed 是相对基准音色的倍率 0.82-1.25,pitch -3~3,emotion∈happy|surprised|calm|fluent|sad|angry,gap_after 是句尾留白秒数 0.05-0.6
- {"action":"assign_asset","clip":"c03","asset":"素材文件名"} 指定某拍用素材库里的录屏/图片
- {"action":"redo_stage","kind":"阶段","note":"具体修改指示"} 重做整个阶段(阶段∈ topic|script|footage|voice|edit|subtitles|deliver;用于"封面换一版""配音慢点""文案重写"这类整阶段的活)。不会直接执行:系统会弹出重做表让她确认是哪一步
- {"action":"reply","text":"回复"} 不需要改片子(闲聊/提问),直接回话

【铁律】回答"右边这是什么/这拍用的什么"类问题,只能基于下面给的真实画面清单回答,清单没有的就直说不知道,绝不许编。
${awaitingBlock}
规则:
- 她说的"第N句"对应列表顺序(c01=第1句)。
- 拿不准指哪句时不要瞎改,用 reply 反问。
- 返回 JSON: {"ops":[...], "reply":"一句口语化的中文确认,说清楚要改什么。别说会连带重出哪些阶段——系统会按依赖自己算好列给她"}`,
        },
        {
          role: "user",
          content: `片子主题:${project.topic}
当前分句:
${clipList}
${assetList}

当前画面真实状态(回答以它为准):
${stateCtx || "(还没有素材产物)"}

她说:${userText}`,
        },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  const text: string | undefined = j.choices?.[0]?.message?.content;
  if (!r.ok || !text) throw new Error(`LLM ${r.status}`);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ops: [{ action: "reply", text }], reply: text };
  const parsed = JSON.parse(m[0]) as ParsedChat;
  if (!Array.isArray(parsed.ops)) parsed.ops = [];
  return parsed;
}

// Apply ops to the clip list; returns new list + what kind of change it was.
// textChanged = 台词变了(脚本变了,配音必重做);beatCountChanged = 拍数变了(画面必重做)。
export function applyOps(
  clips: Clip[],
  ops: ChatOp[],
): { clips: Clip[]; voiceDirty: boolean; footageDirty: boolean; textChanged: boolean; beatCountChanged: boolean } {
  const out = [...clips];
  let voiceDirty = false;
  let footageDirty = false;
  let textChanged = false;
  let beatCountChanged = false;
  const idx = (name: string) => out.findIndex((c) => c.name === name);

  for (const op of ops) {
    if (op.action === "edit_text") {
      const i = idx(op.clip);
      // 台词换了,旧的 tts(带停顿标记的那份)就作废了 —— 留着会照旧句子念
      if (i >= 0 && op.text?.trim()) { out[i] = { ...out[i], text: op.text.trim(), tts: undefined }; voiceDirty = true; textChanged = true; }
    } else if (op.action === "delete_clip") {
      const i = idx(op.clip);
      if (i >= 0) { out.splice(i, 1); voiceDirty = true; footageDirty = true; textChanged = true; beatCountChanged = true; }
    } else if (op.action === "insert_after") {
      const i = idx(op.clip);
      if (i >= 0 && op.text?.trim()) {
        out.splice(i + 1, 0, { name: "tmp", text: op.text.trim(), visual: op.visual });
        voiceDirty = true; footageDirty = true; textChanged = true; beatCountChanged = true;
      }
    } else if (op.action === "edit_delivery") {
      const i = idx(op.clip);
      if (i >= 0 && op.say) {
        out[i] = { ...out[i], say: { ...(out[i].say ?? {}), ...op.say } };
        voiceDirty = true; // 念法变了只要重配音,画面不用动
      }
    } else if (op.action === "edit_visual") {
      const i = idx(op.clip);
      if (i >= 0 && op.visual?.trim()) {
        out[i] = { ...out[i], visual: op.visual.trim(), visualRev: (out[i].visualRev ?? 0) + 1 };
        footageDirty = true;
      }
    } else if (op.action === "assign_asset") {
      const i = idx(op.clip);
      if (i >= 0 && op.asset?.trim()) {
        out[i] = { ...out[i], asset: op.asset.trim() };
        footageDirty = true;
      }
    }
  }
  out.forEach((c, i) => { c.name = `c${String(i + 1).padStart(2, "0")}`; });
  return { clips: out, voiceDirty, footageDirty, textChanged, beatCountChanged };
}
