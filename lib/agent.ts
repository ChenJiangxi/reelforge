// STUB (v0). Target design:
// reelforge's worker is a **hermit agent** (the same framework this whole system runs on, ~/asst).
// It advances a Project through its stages (topic→script→footage→voice→edit→subtitles→polish→deliver),
// self-reviewing each step against the taste playbook (真素材不吹 / no BGM / first-person / 炸裂 opening /
// 数字原值 / 抖音竖版), then flips the stage to `awaiting_review` so the human approves on the 监管台.
// Orchestration mirrors hermit-ui's gateway (tmux-managed agents) — NOT wired in v0.
// In v0, stages are advanced via seed + the review-gate resolve route.

export async function kickoffPipeline(projectId: string) {
  // TODO: spawn / notify the reelforge hermit agent with this project's kickoff prompt.
  //   e.g. create an asst session for a `reelforge-worker` agent and send the topic brief.
  return { queued: true, projectId };
}
