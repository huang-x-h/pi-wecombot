/**
 * pi-wecom-bot
 * 
 * 企业微信群机器人长连接 bridge extension for pi
 * 使用官方 aibot-node-sdk 实现
 * 
 * 参考: https://developer.work.weixin.qq.com/document/path/101463
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import Aibot from "aibot-node-sdk";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Types
// ============================================================================

interface BotConfig {
  key?: string;
  secret?: string;
  enabled?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_PATH = join(homedir(), ".pi", "agent", "wecom-bot.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "wecom-bot");
const MAX_MSG = 4096;
const MAX_FILES = 10;

const PROMPT = `
企业微信机器人桥接已激活 [wecom-bot]。
- 收到群消息会自动转发给 pi 处理
- 回复会自动发送到群聊
- 使用 wecombot_attach 发送文件`;

// ============================================================================
// Helpers
// ============================================================================

function mimeType(name: string): string {
  const e = name.split(".").pop()?.toLowerCase();
  const m: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
    mp3: "audio/mpeg", pdf: "application/pdf", txt: "text/plain",
  };
  return m[e || ""] || "application/octet-stream";
}

function isImg(m: string): boolean { return m.startsWith("image/"); }

function splitText(s: string): string[] {
  if (s.length <= MAX_MSG) return [s];
  const r: string[] = [];
  for (let i = 0; i < s.length; i += MAX_MSG) r.push(s.slice(i, i + MAX_MSG));
  return r;
}

async function loadConfig(): Promise<BotConfig> {
  try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

async function saveConfig(c: BotConfig) {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(c, null, "\t") + "\n");
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let cfg: BotConfig = {};
  let bot: any = null;
  let ok = false;
  let busy = false;

  // Status
  function stat(ctx: ExtensionContext, err?: string) {
    const t = ctx.ui.theme;
    if (err) ctx.ui.setStatus("wecom-bot", `${t.fg("accent", "wecom-bot")} ${t.fg("error", err)}`);
    else if (!cfg.key) ctx.ui.setStatus("wecom-bot", `${t.fg("accent", "wecom-bot")} ${t.fg("muted", "not set")}`);
    else ctx.ui.setStatus("wecom-bot", `${t.fg("accent", "wecom-bot")} ${t.fg(ok ? "success" : "warning", ok ? "✅" : "⚡")}`);
  }

  // Start
  async function start(ctx: ExtensionContext) {
    if (!cfg.key) return;
    stop();

    console.log("[wecom-bot] 启动中...");
    bot = new Aibot({ key: cfg.key, secret: cfg.secret });

    bot.on("onStart", () => {
      console.log("[wecom-bot] ✅ 已连接");
      ok = true; stat(ctx);
    });

    bot.on("onMessage", (msg: any) => {
      const txt = msg.content || msg.text?.content || "";
      if (!txt) return;
      console.log("[wecom-bot] 收到:", txt.slice(0, 50));
      pi.sendUserMessage([{ type: "text", text: `[wecom-bot] ${txt}` }]);
    });

    bot.on("onClose", () => {
      console.log("[wecom-bot] ❌ 断开");
      ok = false; stat(ctx);
      if (cfg.enabled) setTimeout(() => start(ctx), 5000);
    });

    bot.on("onError", (e: any) => {
      console.log("[wecom-bot] 错误:", e?.message || e);
      ok = false; stat(ctx, e?.message || "error");
    });

    bot.start();
  }

  function stop() {
    if (bot) { bot.stop(); bot = null; }
    ok = false;
  }

  // Send
  async function sendText(txt: string) {
    if (!bot) return;
    for (const s of splitText(txt)) bot.sendText(s);
  }

  async function sendMd(md: string) {
    if (!bot) return;
    for (const s of splitText(md)) bot.sendMarkdown(s);
  }

  async function sendImg(b64: string, md: string) {
    if (!bot) return;
    bot.sendImage(b64, md);
  }

  // Setup
  async function setup(ctx: ExtensionContext) {
    const url = await ctx.ui.input("Webhook URL", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx");
    if (!url) return;

    // 从URL提取key
    const key = new URL(url).searchParams.get("key");
    if (!key) { ctx.ui.notify("❌ URL中未找到key", "error"); return; }

    const secret = await ctx.ui.input("加签密钥(可选)", "");
    cfg = { key, secret: secret || undefined, enabled: true };
    await saveConfig(cfg);
    ctx.ui.notify("✅ 已保存", "success");
    await start(ctx);
  }

  // Tools
  pi.registerTool({
    name: "wecombot_attach",
    label: "WeCom Attach",
    description: "发送文件到企业微信群",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_FILES }),
    }),
    async execute(_id, p) {
      const files: string[] = [];
      for (const fp of p.paths) {
        if ((await stat(fp)).isFile()) files.push(fp);
      }
      if (bot && files.length) {
        for (const fp of files) {
          const mt = mimeType(fp);
          if (isImg(mt)) {
            const buf = await readFile(fp);
            await sendImg(buf.toString("base64"), buf.toString("hex").slice(0, 32));
          } else {
            await sendText(`📎 ${basename(fp)}`);
          }
        }
      }
      return { content: [{ type: "text", text: `已添加 ${files.length} 个文件` }], details: {} };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "WeCom Send",
    description: "发送消息到群聊",
    parameters: Type.Object({
      message: Type.String(),
      type: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("markdown")])),
    }),
    async execute(_id, p) {
      if (!bot) throw new Error("机器人未连接");
      if (p.type === "markdown") await sendMd(p.message);
      else await sendText(p.message);
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // Commands
  pi.registerCommand("wecom-bot-setup", {
    description: "配置企业微信机器人",
    handler: async (a, ctx) => { await setup(ctx); },
  });

  pi.registerCommand("wecom-bot-status", {
    description: "查看状态",
    handler: async (_a, ctx) => {
      if (!cfg.key) ctx.ui.notify("❌ 未配置", "warning");
      else ctx.ui.notify(`${ok ? "✅" : "⚡"} ${cfg.key?.slice(0, 8)}...`, "info");
    },
  });

  pi.registerCommand("wecom-bot-test", {
    description: "发送测试",
    handler: async (_a, ctx) => {
      if (!cfg.key) { ctx.ui.notify("请先配置", "warning"); return; }
      await sendText(`🧪 ${new Date().toLocaleString("zh-CN")} | pi-wecom`);
      ctx.ui.notify("✅ 已发送", "success");
    },
  });

  // Events
  pi.on("session_start", async (_e, ctx) => {
    cfg = await loadConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    if (cfg.enabled && cfg.key) await start(ctx);
    stat(ctx);
  });

  pi.on("session_shutdown", () => { stop(); });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    busy = false; stat(ctx);
    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;
    if (txt.includes("```") || txt.startsWith("#")) await sendMd(txt);
    else await sendText(txt);
  });

  return { cfg: () => cfg };
}
