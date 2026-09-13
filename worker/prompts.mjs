// Taste playbook baked into every creative prompt — Jessy's hard standards,
// carried over from the ops-bilibili video-pipeline.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 视觉教案(画面生成的"skill")——可独立编辑,worker 启动时读入。
const VISUAL_TASTE = (() => {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "playbooks", "visual.md"), "utf8").trim();
  } catch {
    return "";
  }
})();

export { VISUAL_TASTE };
export const TASTE = `
审美硬标准(必须遵守):
- 真素材不吹:数字只用真实值,绝不编热搜、假统计、假案例。没有真数字就不谈数字。
- 开头要炸:第一句就定主旨、有冲击力,绝不娓娓道来。禁止"大家好""今天聊聊"。
- 人味:像真人说话,有态度有判断。不营销腔、不卖萌、不喊口号、不堆形容词。
- 每句台词都要"说什么显什么":画面内容必须和这句台词直接相关,不是通用空镜。
- 只暗合不硬广:涉及产品时点到为止,不念广告词。
- 克制:不夸大、不绝对化(避免"史上最强""彻底颠覆"这类词)。
`.trim();

export const PROMPTS = {
  topic: (item) => [
    {
      role: "system",
      content: `你是短视频选题策划,为抖音/B站口播视频定角度。\n${TASTE}`,
    },
    {
      role: "user",
      content: `原始想法:${item.topic}
平台:${item.platform === "bilibili" ? "B站横版" : "抖音竖版"},目标时长 ~${item.duration} 秒。
${item.artifacts?.material ? `\n参考材料(真实资料,内容优先从这里出,别自己编):\n${item.artifacts.material}\n` : ""}

把这个想法收束成一个能拍的选题。返回 JSON(不要多余文字):
{
  "angle": "切入角度,一句话说清这条片子讲什么、跟别人讲法差在哪",
  "hook": "开场钩子——视频第一句话,要炸、要让人停下滑动的手指",
  "claims": ["这条片子要讲的 3-4 个真实判断/事实,每句一行"],
  "avoid": ["绝不能吹的 3 句话——写出来是为了不踩"],
  "title": "项目标题(≤20字,不是视频标题,是内部管理用)"
}`,
    },
  ],

  script: (item, topic) => [
    {
      role: "system",
      content: `你是短视频口播编剧。写的是一篇"能一口气念下来"的稿子,不是金句清单。
${TASTE}

叙事结构(60-90秒口播的标准弧线,按此推进):
1. hook 钩子:第一句制造矛盾/反问/反差(三种轮换着用,别只会甩数字)。3秒内让人停下来。
2. context 展开:钩子之后给必要的背景——为什么会这样?一两句就够,别铺垫。
3. evidence 证据:具体的人、事、数字(只用真实值)。这是肉。
4. turn 转折:"但真正的重点是……"——把前面说的重新定义一次。全片最需要判断力的地方。
5. landing 落点:所以对观众意味着什么?一句有立场的结论,不是空洞升华。

句间连贯(这次的重点,必须做到):
- 每句话必须承接上一句:用"但/所以/结果呢/换句话说/你可能会想/这意味着/更关键的是"这类承接,或者明确的指代("这套逻辑""它们""这事儿")。
- 禁止清单体:不许每句一个独立观点、句与句之间可以任意调换顺序。稿子的句子是有先后的,挪了就讲不通,这才叫有逻辑。
- 长短句混排:两三句短的砸一个节奏点,跟一句长的把逻辑说透。不许每句一样长。
- 连接词别每句都用同一个;"首先/其次/最后"禁用。

画面按节拍走:一个节拍(beat)= 一个完整意思,1-3 句话,8-15 秒。不是一句话一个画面。`,
    },
    {
      role: "user",
      content: `选题角度:${topic.angle}
${topic.material ? `参考材料(真实资料,数字/案例从这里出):\n${topic.material}\n` : ""}
开场钩子方向:${topic.hook}
要讲的判断:${(topic.claims || []).join(" / ")}
绝不能吹:${(topic.avoid || []).join(" / ")}
配音语言:${item.voice === "minimax-en" ? "英文(地道、有激情的旁白)" : "中文(第一人称)"}
目标时长 ~${item.duration} 秒(中文 4.7 字/秒,总字数 = 时长×4.7 ±15%,大约 ${Math.round(item.duration * 4.7 * 0.85)}-${Math.round(item.duration * 4.7 * 1.15)} 字)。

返回 JSON(不要多余文字):
{
  "narration": "完整口播稿全文(连贯的一篇,分段)",
  "clips": [
    {
      "name": "c01",
      "beat": "hook|context|evidence|turn|landing 之一",
      "text": "这个节拍的口播(1-3句完整的话)",
      "visual_type": "text|data|quote|contrast|step|diagram|table|flow 之一",
      "visual": "画面简报:这拍卡上要出现什么具体内容"
    }
  ]
}
clips 5-7 个,全片覆盖 hook→landing 完整弧线。text 加起来就是 narration,不许缺段。visual_type:关系/相互作用(生克合冲)用 diagram,多方对照用 table,流程步骤用 flow,金句用 quote,关键数字用 data;纯文字 text 只是兜底——知识内容必须有结构。`,
    },
  ],

  scriptCritique: (item, draft) => [
    {
      role: "system",
      content: `你是毒舌但专业的短视频主编。审一篇口播稿,只挑真毛病,按清单过:
1. 连贯性:逐句读,每句是否真的承接上一句?标出"可以任意调换顺序"的句子——那是清单体,必须改。
2. 人味:有没有 AI 腔(排比堆砌、空洞升华、"让我们一起"、每句一样长、书面语)?改成口语。
3. 钩子:第一句 3 秒内能不能让人停下来?不行就换。
4. 真实:数字/案例是不是具体可信?含糊的("很多人""越来越多")改成具体说法或删掉。
5. 完整:每拍的话是不是完整的意思(不是半句)?全片是否覆盖了 hook→landing 弧线?`,
    },
    {
      role: "user",
      content: `这是初稿(JSON):
${JSON.stringify(draft, null, 1)}

按清单改完,返回同样结构的完整 JSON(narration + clips)。没毛病的地方别动。目标时长 ~${item.duration} 秒(4.7 字/秒)。`,
    },
  ],

  card: (item, clip, i, n) => {
    const assets = (item.assets || []).filter((a) => a.kind === "video" || a.kind === "image");
    const mine = assets.filter((a) => !a.global);
    const shared = assets.filter((a) => a.global);
    const assetBlock = assets.length
      ? `\n\n素材库(真素材,能用就用——真素材永远比字卡好):\n${mine.length ? `本项目上传:\n${mine.map((a) => `- "${a.name}"(${a.kind === "video" ? "录屏视频" : "图片"})`).join("\n")}\n` : ""}${shared.length ? `全局共享素材库:\n${shared.map((a) => `- "${a.name}"(${a.kind === "video" ? "录屏视频" : "图片"})`).join("\n")}` : ""}
如果这一拍该用素材库里的某个素材(比如这拍在讲产品功能,正好有对应录屏),返回 {"asset": "文件名"} 而不是字卡设计。别把素材浪费在不相关的拍上;没有合适的就正常设计字卡。`
      : "";
    return [
      {
        role: "system",
        content: `你是短视频画面设计,把一节口播设计成一张卡的内容。\n${TASTE}\n\n${VISUAL_TASTE}\n\n卡片语言:${item.voice === "minimax-en" ? "英文" : "中文"}。`,
      },
      {
        role: "user",
        content: `第 ${i + 1}/${n} 拍(${clip.beat || "?"},脚本建议画面类型:${clip.visual_type || "text"}):
口播:"${clip.text}"
画面简报:${clip.visual || "(无,自行设计)"}${assetBlock}

卡型选择(按内容选,别惯性):
- 关系/相互作用(A 生 B、X 克 Y、双方匹配) → diagram(节点+带标签箭头)
- 两方/多方多项对照(他的 vs 你的,旧 vs 新) → table(对照表)
- 流程/步骤/先后顺序 → flow(编号步骤链)
- 金句(能单独截图传播) → quote;关键数字 → data;真对立一句话 → contrast
- 纯文字大字卡(text)只兜底——知识内容不许用 text 糊弄;每一拍的信息量要顶得上一段话
脚本建议的类型不合适就换对的。返回 JSON:
{
  "type": "text|data|quote|contrast|step|diagram|table|flow 之一",
  "kicker": "顶部小字标签(≤12字,可空)",
  "big": "主标题/主信息(≤10字;data=数字本体;table/flow=这一表的标题)",
  "sub": "一行补充(≤20字,可空)",
  "big2": "仅 contrast 用", "step_no": "仅 step 用",
  "nodes": [{"label":"节点名","sub":"一行小注(可空)","nextLabel":"到下一个节点的关系词(如 生/克/合)","tone":"accent 可空"}],
  "cols": ["列头1","列头2"], "rows": [["行1列1","行1列2"]],
  "steps": [{"label":"步骤名","sub":"一行小注(可空)"}],
  "foot": "底部小字备注(通常空)"
}
nodes/cols/rows/steps 只填当前 type 需要的,其它省略。`,
      },
    ];
  },

  cover: (item, topic, script) => [
    {
      role: "system",
      content: `你是抖音封面设计。封面风格:巨字+戏剧化,爆款风,但不能 tacky(不用感叹号轰炸、不低俗)。${TASTE}\n\n${VISUAL_TASTE}`,
    },
    {
      role: "user",
      content: `视频选题:${topic.angle}
开场:${topic.hook}

设计竖版封面文案,返回 JSON:
{"main": "封面主标题(≤8字,巨字)", "sub": "副标题(≤12字)", "tone": "封面主色,从 amber|red|cyan|violet 选一个"}`
    },
  ],

  caption: (item, topic, scriptText) => [
    {
      role: "system",
      content: `你是抖音运营,写发布文案。${TASTE}`,
    },
    {
      role: "user",
      content: `视频主题:${topic.angle}
口播稿:
${scriptText}

写抖音发布文案,返回 JSON:
{
  "title": "标题(带可搜索关键词,≤30字)",
  "hashtags": ["#话题1", "#话题2"],
  "desc": "简介前100字,勾住人点开,不剧透全部"
}
hashtags 5-8 个,混合大词(如 #AI)和精准词。`,
    },
  ],
};
