import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { STAGE_ORDER } from "@/lib/stages";

// POST /api/project/[id]/script { narration } — she edits the script text
// directly (chatcut 的"改文字就剪视频"). We re-segment HER EXACT TEXT into
// clips via DeepSeek, then reset downstream stages so everything regenerates.
// If the stage was awaiting review, her edit = approve with her version.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { narration } = await req.json().catch(() => ({}));
  const text = String(narration ?? "").trim();
  if (text.length < 20) return NextResponse.json({ error: "稿子太短" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    include: { stages: { orderBy: { order: "asc" } } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const scriptStage = project.stages.find((s) => s.kind === "script");
  if (!scriptStage) return NextResponse.json({ error: "no script stage" }, { status: 404 });
  const oldArt = scriptStage.artifacts ? JSON.parse(scriptStage.artifacts) : {};
  const oldClips = Array.isArray(oldArt.clips) ? oldArt.clips : [];

  // Re-segment her text into beats. The text is law — LLM must not rewrite it.
  const key = process.env.OPENROUTER_API_KEY;
  let clips;
  if (key) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "deepseek/deepseek-v3.2",
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
          {
            role: "system",
            content: `你是分镜师。用户改好了一篇口播稿,你唯一的活:把它按节拍切成 clips。
铁律:文字一个标点都不能改——你只是分段,不是编辑。
每拍 1-3 句完整意思(8-15 秒配音量),开头钩子句单独一拍。
同时给每拍标出"怎么念"(say/tts),否则整片会一个语速念到尾,像念经。
返回 JSON:{"clips":[{"text":"原文原句","tts":"同一句话,可插 <#0.3#> 停顿标记","say":{"speed":1.0,"pitch":0,"emotion":"fluent","gap_after":0.25},"beat":"hook|context|evidence|turn|landing","visual_type":"text|data|quote|contrast|step","visual":"画面简报"}]}
text 拼起来必须等于原文(允许去掉多余空行)——tts 里除了 <#x#> 标记,一个字也不许多不许少。
visual/say 沿用旧简报:文字没变的拍,直接抄旧 clips 里的 visual 和 say;新拍自己定。
念法规矩:钩子 speed 1.12-1.25、pitch +1~+3;落点 speed 0.85-0.95、pitch -2;
转折那拍开头先 <#0.4#>;关键数字前 <#0.25#>;相邻两拍 speed 至少差 0.08。`,
          },
          {
            role: "user",
            content: `旧 clips(供沿用 visual/say):
${JSON.stringify(oldClips.map((c: { text: string; visual?: string; say?: unknown }) => ({ text: c.text, visual: c.visual, say: c.say })), null, 1)}

她改好的稿子(全文,逐字保留):
${text}`,
          },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    const raw = j.choices?.[0]?.message?.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    clips = m ? JSON.parse(m[0]).clips : null;
  }
  // LLM 挂了也能存:整段当一拍,人工兜底
  if (!Array.isArray(clips) || !clips.length) {
    clips = [{ text, beat: "hook", visual_type: "text", visual: "" }];
  }
  // LLM 偶尔把停顿标记漏进 text(字幕会念出 <#0.3#>),或者 tts 把字改了 —— 两边都兜底
  for (const c of clips as { text: string; tts?: string }[]) {
    c.text = String(c.text ?? "").replace(/<#[\d.]+#>/g, "");
    if (c.tts && c.tts.replace(/<#[\d.]+#>/g, "") !== c.text) c.tts = undefined;
  }
  clips.forEach((c: { name?: string }, i: number) => { c.name = `c${String(i + 1).padStart(2, "0")}`; });

  await prisma.stage.update({
    where: { id: scriptStage.id },
    data: {
      status: "approved", // 她亲手改的稿子,编辑即通过
      artifacts: JSON.stringify({
        ...oldArt,
        script: text,
        clips,
        note: `你亲手改的稿(${clips.length} 拍)。画面/配音/剪辑/字幕重出中。`,
      }),
    },
  });

  // downstream regenerates (voice is dirty by definition; cards may reference old lines)
  const fromOrder = STAGE_ORDER.indexOf("footage");
  // 连 working 中的阶段也翻回 pending:submit 的竞态守卫会作废它按旧输入产出的结果
    for (const s of project.stages) {
    if (s.order >= fromOrder) {
      await prisma.stage.update({ where: { id: s.id }, data: { status: "pending" } });
    }
  }
  await prisma.project.update({ where: { id }, data: { status: "producing" } });
  await prisma.message.create({
    data: { projectId: id, role: "agent", text: "脚本按你改的版本定稿了。画面/配音/剪辑/字幕重出中,好了喊你审。" },
  });

  return NextResponse.json({ ok: true });
}
