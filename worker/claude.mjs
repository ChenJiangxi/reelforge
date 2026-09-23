// 本机 Claude(Claude Code 无头模式)当管线的大脑:写稿、排镜头、改稿、看图都走这里。
// 用的是这台机器登录的 Claude 订阅,不按次计费(2026-09-24 她定:不用 DeepSeek 了,改用本机 Claude)。
//
// 为什么这么调:
//   --tools ""              纯问答,不让它动文件、跑命令
//   --strict-mcp-config     不加载本机的 MCP 插件
//   --setting-sources project + 干净的工作目录   不加载本机用户级的钩子(记忆检查之类)和 CLAUDE.md
//   --system-prompt-file    换掉 Claude Code 自带的系统提示词,只留我们的
//   去掉 CLAUDE* / ANTHROPIC* / AI_AGENT 环境变量   否则会被当成嵌套会话(ops-bilibili 踩过)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";

// pm2 起的进程 PATH 里不一定有 ~/.local/bin,优先用绝对路径
const LOCAL_BIN = join(homedir(), ".local", "bin", "claude");
const BIN = process.env.CLAUDE_BIN || (existsSync(LOCAL_BIN) ? LOCAL_BIN : "claude");
const CWD = join(tmpdir(), "reelforge-claude");
mkdirSync(CWD, { recursive: true });

// 同时最多几个 Claude 在跑:这台机器上还有别的 agent 在用同一个订阅,别一次开太多
const MAX = Math.max(1, Number(process.env.CLAUDE_CONC) || 3);
let running = 0;
const queue = [];
async function slot() {
  if (running < MAX) {
    running++;
    return;
  }
  await new Promise((r) => queue.push(r));
  running++;
}
function release() {
  running--;
  const next = queue.shift();
  if (next) next();
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/.test(k) || k === "AI_AGENT" || k === "CLAUDECODE") continue;
    env[k] = v;
  }
  return env;
}

const textOf = (c) => (typeof c === "string" ? c : (c || []).filter((p) => p.type === "text").map((p) => p.text).join("\n"));

/**
 * OpenAI 风格的 messages → Claude 的输入。
 * 多轮(补正时"上一版 + 要这么改")拼成一段带标签的文字;图片(data URL)转成 base64 图块。
 */
export function toClaudeInput(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const images = [];
  for (const m of rest) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const url = p.type === "image_url" ? p.image_url?.url : null;
      const mm = url && url.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
      if (mm) images.push({ media_type: mm[1], data: mm[2] });
    }
  }
  let prompt;
  if (rest.length === 1) prompt = textOf(rest[0].content);
  else {
    let seenUser = false;
    prompt = rest
      .map((m) => {
        if (m.role === "assistant") return `【你上一次的回答】\n${textOf(m.content)}`;
        const label = seenUser ? "【现在的要求】" : "【任务】";
        seenUser = true;
        return `${label}\n${textOf(m.content)}`;
      })
      .join("\n\n");
  }
  return { system, prompt, images };
}

/** 额度用完这类错误不要重试,直接说清楚 */
export class ClaudeLimitError extends Error {}

/**
 * 跑一次。返回 {text, usage, durationMs, model}
 * model: opus(写稿、排镜头这类要质量的)| sonnet(聊天框、看图这类要快的)
 */
export async function claudeRun({ system = "", prompt, images = [], model = "opus", timeoutMs = 300_000 }) {
  await slot();
  const id = randomUUID().slice(0, 8);
  const sysFile = join(CWD, `sys-${id}.txt`);
  try {
    writeFileSync(sysFile, system || "按要求回答。");
    const vision = images.length > 0;
    const args = [
      "-p",
      "--model", model,
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "project",
      "--no-session-persistence",
      "--system-prompt-file", sysFile,
      "--output-format", vision ? "stream-json" : "json",
      ...(vision ? ["--input-format", "stream-json", "--verbose"] : []),
    ];
    const t0 = Date.now();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(BIN, args, { cwd: CWD, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`本机 Claude ${Math.round(timeoutMs / 1000)} 秒没回话,已中止`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearTimeout(killer);
        reject(new Error(`起不来本机 Claude(${e.message});渲染机上装了 claude 命令吗`));
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve({ code, stdout, stderr });
      });
      if (vision) {
        const content = [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text: prompt }];
        child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
      } else child.stdin.end(prompt);
    });
    let result = null;
    if (vision) {
      for (const line of out.stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === "result") result = j;
        } catch {
          /* 不是 JSON 的行 */
        }
      }
    } else {
      try {
        result = JSON.parse(out.stdout);
      } catch {
        /* 下面统一报错 */
      }
    }
    if (!result) throw new Error(`本机 Claude 没给出结果(退出码 ${out.code}):${(out.stderr || out.stdout).slice(0, 200)}`);
    const text = String(result.result ?? "");
    if (result.is_error) {
      if (/limit|usage|quota|额度|rate/i.test(text)) throw new ClaudeLimitError(`本机 Claude 额度用完了:${text.slice(0, 160)}。等额度恢复后点「重试」`);
      throw new Error(`本机 Claude 报错:${text.slice(0, 200)}`);
    }
    return { text, usage: result.usage, durationMs: Date.now() - t0, model, costNotional: result.total_cost_usd };
  } finally {
    rmSync(sysFile, { force: true });
    release();
  }
}
