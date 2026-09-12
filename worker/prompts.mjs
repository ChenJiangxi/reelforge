// Taste playbook baked into every creative prompt — Jessy's hard standards,
// carried over from the ops-bilibili video-pipeline.
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
      content: `你是口播视频编剧,写第一人称口播稿。\n${TASTE}\n分句要求:每句是一个独立镜头(clip),一句话一个画面。句子短,口语化,适合配音念出来。`,
    },
    {
      role: "user",
      content: `选题角度:${topic.angle}
开场钩子:${topic.hook}
要讲的判断:${(topic.claims || []).join(" / ")}
绝不能吹:${(topic.avoid || []).join(" / ")}
配音语言:${item.voice === "minimax-en" ? "英文(地道、有激情的旁白)" : "中文(第一人称)"}
目标时长 ~${item.duration} 秒(中文约 4.7 字/秒,英文约 2.5 词/秒,按此控制总长度)。

写完整口播稿,返回 JSON:
{
  "clips": [
    {"name": "c01", "text": "这句台词(开场第一句必须用钩子)", "visual": "这句对应的画面内容,具体到元素(如:大字卡\"25分\",柱状图对比,手机录屏界面)"}
  ]
}
clip 数量 7-12 个。name 用 c01..cNN。visual 是给画面生成用的简报,要具体。`,
    },
  ],

  card: (item, clip, i, n) => [
    {
      role: "system",
      content: `你是短视频画面设计,把一句台词设计成一张大字卡的内容。\n${TASTE}\n卡片语言:${item.voice === "minimax-en" ? "英文" : "中文"}。`,
    },
    {
      role: "user",
      content: `第 ${i + 1}/${n} 句台词:"${clip.text}"
画面简报:${clip.visual || "(无,自行设计)"}

设计这张卡的内容,返回 JSON:
{
  "type": "text 或 data(台词里有具体数字/对比时用 data)",
  "kicker": "顶部小字(≤12字,可空字符串)",
  "big": "主视觉大字(≤10字,越短越有冲击力;data 卡这里是数字本体,如\"34分\"\"37-50\")",
  "sub": "大字下面一行解释(≤20字,可空)",
  "foot": "底部一行小字备注(≤16字,通常空)"
}`,
    },
  ],

  cover: (item, topic, script) => [
    {
      role: "system",
      content: `你是抖音封面设计。封面风格:巨字+戏剧化,爆款风,但不能 tacky(不用感叹号轰炸、不低俗)。${TASTE}`,
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
