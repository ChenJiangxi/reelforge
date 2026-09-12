// Chat → clip-level edit ops, parsed by DeepSeek on the server (cheap: ~1k tokens/msg).
// The video is a sequence of 分句 clips (大字卡 + 配音), so "对话剪辑" =
// natural-language ops on that clip list, then downstream stages regenerate.

export type Clip = { name: string; text: string; visual?: string };

export type ChatOp =
  | { action: "edit_text"; clip: string; text: string }
  | { action: "delete_clip"; clip: string }
  | { action: "insert_after"; clip: string; text: string; visual?: string }
  | { action: "edit_visual"; clip: string; visual: string }
  | { action: "redo_stage"; kind: string; note: string }
  | { action: "reply"; text: string };

export type ParsedChat = { ops: ChatOp[]; reply: string };

const MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v3.2";

export async function parseChat(
  userText: string,
  clips: Clip[],
  project: { topic: string; title: string },
): Promise<ParsedChat> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { ops: [], reply: "服务器还没配 LLM key,这条我先记下了,暂时没法自动改。" };
  }
  const clipList = clips.length
    ? clips.map((c) => `${c.name}: "${c.text}"(画面:${c.visual || "无"})`).join("\n")
    : "(还没有分句——脚本阶段还没产出)";

  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
- {"action":"redo_stage","kind":"阶段","note":"具体修改指示"} 重做整个阶段(阶段∈ topic|script|footage|voice|edit|subtitles|deliver;用于"封面换一版""配音慢点""文案重写"这类整阶段的活)
- {"action":"reply","text":"回复"} 不需要改片子(闲聊/提问),直接回话
规则:
- 她说的"第N句"对应列表顺序(c01=第1句)。
- 拿不准指哪句时不要瞎改,用 reply 反问。
- 返回 JSON: {"ops":[...], "reply":"一句口语化的中文确认,说清楚要改什么、会有什么连锁(重新配音/重剪)"}`,
        },
        {
          role: "user",
          content: `片子主题:${project.topic}
当前分句:
${clipList}

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

// Apply ops to the clip list; returns new list + whether voice/footage are affected.
export function applyOps(clips: Clip[], ops: ChatOp[]): { clips: Clip[]; voiceDirty: boolean; footageDirty: boolean } {
  const out = [...clips];
  let voiceDirty = false;
  let footageDirty = false;
  const idx = (name: string) => out.findIndex((c) => c.name === name);

  for (const op of ops) {
    if (op.action === "edit_text") {
      const i = idx(op.clip);
      if (i >= 0 && op.text?.trim()) { out[i] = { ...out[i], text: op.text.trim() }; voiceDirty = true; }
    } else if (op.action === "delete_clip") {
      const i = idx(op.clip);
      if (i >= 0) { out.splice(i, 1); voiceDirty = true; footageDirty = true; }
    } else if (op.action === "insert_after") {
      const i = idx(op.clip);
      if (i >= 0 && op.text?.trim()) {
        out.splice(i + 1, 0, { name: "tmp", text: op.text.trim(), visual: op.visual });
        voiceDirty = true; footageDirty = true;
      }
    } else if (op.action === "edit_visual") {
      const i = idx(op.clip);
      if (i >= 0 && op.visual?.trim()) { out[i] = { ...out[i], visual: op.visual.trim() }; footageDirty = true; }
    }
  }
  out.forEach((c, i) => { c.name = `c${String(i + 1).padStart(2, "0")}`; });
  return { clips: out, voiceDirty, footageDirty };
}
