import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.stage.deleteMany();
  await prisma.project.deleteMany();

  const project = await prisma.project.create({
    data: {
      title: "AI 算命 能追上人类顶尖命理师吗",
      topic: "AI 算命 benchmark（BaziQA · 灵伴排进前三）",
      platform: "douyin",
      status: "reviewing",
    },
  });

  const stages: {
    kind: string;
    order: number;
    status: string;
    artifacts: Record<string, unknown>;
  }[] = [
    { kind: "topic", order: 0, status: "approved", artifacts: { note: "选题：AI 算命 benchmark（灵伴排进前三，真论文数据）" } },
    { kind: "script", order: 1, status: "approved", artifacts: { script: "AI 算命，能追上人类顶尖命理师吗？…（论文 benchmark 口播稿，第一人称、开头炸）" } },
    { kind: "footage", order: 2, status: "approved", artifacts: { note: "素材：paper-figure HTML 卡 + 灵伴五年综合测评图" } },
    { kind: "voice", order: 3, status: "approved", artifacts: { note: "配音：Jessy 克隆音，开头 emotion=happy 加激情" } },
    {
      kind: "edit",
      order: 4,
      status: "awaiting_review",
      artifacts: {
        video: "/seed/paper.mp4",
        script: "开头：AI 算命，能追上人类顶尖命理师吗？ → 论文/benchmark → 五年综合排行(灵伴 46，第 3) → SRP → 收尾。",
        note: "2:06，横版 1080p，纯人声。抖音发布需出竖版——见交付阶段。",
      },
    },
    { kind: "subtitles", order: 5, status: "approved", artifacts: { note: "字幕：已烧进片" } },
    { kind: "polish", order: 6, status: "pending", artifacts: { note: "润色：待剪辑通过后" } },
    {
      kind: "deliver",
      order: 7,
      status: "pending",
      artifacts: {
        cover: "/seed/cover-v.png",
        caption: {
          title: "AI 算命，能追上人类顶尖命理师吗？我们写了篇论文",
          hashtags: ["#AI算命", "#八字", "#玄学", "#灵伴", "#命理"],
          desc: "用全球命理师大赛真题考 AI——灵伴排进前三、超过人类季军。",
        },
      },
    },
  ];

  for (const s of stages) {
    await prisma.stage.create({
      data: {
        projectId: project.id,
        kind: s.kind,
        order: s.order,
        status: s.status,
        artifacts: JSON.stringify(s.artifacts),
      },
    });
  }

  console.log("seeded project", project.id);
}

main().finally(() => prisma.$disconnect());
