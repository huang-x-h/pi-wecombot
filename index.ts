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
import { readFileSync } from "node:fs";
import Aibot from "aibot-node-sdk";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Type Definitions
// ============================================================================

interface WeComBotConfig {
  webhookUrl?: string;
  secret?: string;
  enabled?: boolean;
}

interface QueuedAttachment {
  path: string;
  fileName: string;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_PATH = join(homedir(), ".pi", "agent", "wecom-bot.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "wecom-bot");
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS = 10;

const SYSTEM_PROMPT = `
企业微信机器人桥接扩展已激活。
- 所有通过企业微信机器人发送的消息都会标记 [wecom-bot]
- 机器人在群聊中推送消息
- 如果用户请求文件或生成的产物，调用 wecombot_attach 工具将其发送到企业微信群`;

// ============================================================================
// Helpers
// ============================================================================

function guessMimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
    mp3: "audio/mpeg", pdf: "application/pdf",
    txt: "text/plain", json: "application/json",
  };
  return map[ext || ""] || "application/octet-stream";
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
  }
  return chunks;
}

async function readConfig(): Promise<WeComBotConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function saveConfig(config: WeComBotConfig): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n");
}

// ============================================================================
// Main Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let config: WeComBotConfig = {};
  let aibot: any = null;
  let activeMessage: { content: Array<TextContent | ImageContent> } | null = null;
  let setupDone = false;
  let connected = false;

  // ------------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------------
  function status(ctx: ExtensionContext, error?: string): void {
    const t = ctx.ui.theme;
    const label = t.fg("accent", "wecom-bot");

    if (error) {
      ctx.ui.setStatus("wecom-bot", `${label} ${t.fg("error", error)}`);
      return;
    }

    if (!config.webhookUrl) {
      ctx.ui.setStatus("wecom-bot", `${label} ${t.fg("muted", "not configured")}`);
      return;
    }

    ctx.ui.setStatus("wecom-bot", `${label} ${t.fg(connected ? "success" : "warning", connected ? "✅" : "⚡"}`);
  }

  // ------------------------------------------------------------------------
  // 启动机器人
  // ------------------------------------------------------------------------
  async function startBot(ctx: ExtensionContext): Promise<void> {
    if (!config.webhookUrl) {
      console.log("[wecom-bot] 需要配置 Webhook URL");
      return;
    }

    console.log("[wecom-bot] 正在启动...");

    try {
      // 从 Webhook URL 提取 key
      const url = new URL(config.webhookUrl);
      const key = url.searchParams.get("key");

      if (!key) {
        console.log("[wecom-bot] Webhook URL 中未找到 key");
        status(ctx, "key not found");
        return;
      }

      // 创建 aibot 实例
      aibot = new Aibot({
        key, // 必填，机器人key
        secret: config.secret || undefined, // 选填，加签密钥
      });

      // 监听启动事件
      aibot.on("onStart", () => {
        console.log("[wecom-bot] ✅ 机器人启动成功");
        connected = true;
        status(ctx);
      });

      // 监听消息事件
      aibot.on("onMessage", (msg: any) => {
        console.log("[wecom-bot] 收到消息:", JSON.stringify(msg).slice(0, 200));

        // 处理文本消息
        const content = msg.content || msg.text?.content || "";
        if (content) {
          // 将消息转发给 pi 处理
          const prompt = `[wecom-bot] ${content}`;
          pi.sendUserMessage([{ type: "text", text: prompt }]);
        }
      });

      // 监听关闭事件
      aibot.on("onClose", () => {
        console.log("[wecom-bot] ❌ 连接关闭");
        connected = false;
        status(ctx);
      });

      // 监听错误事件
      aibot.on("onError", (err: any) => {
        console.log("[wecom-bot] ❌ 错误:", err);
        status(ctx, err.message || "error");
      });

      // 启动机器人
      aibot.start();

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log("[wecom-bot] 启动失败:", msg);
      status(ctx, msg);
    }
  }

  // ------------------------------------------------------------------------
  // 停止机器人
  // ------------------------------------------------------------------------
  function stopBot(): void {
    if (aibot) {
      aibot.stop();
      aibot = null;
    }
    connected = false;
  }

  // ------------------------------------------------------------------------
  // 发送消息
  // ------------------------------------------------------------------------
  async function sendText(text: string): Promise<void> {
    if (!aibot) {
      console.log("[wecom-bot] 机器人未启动");
      return;
    }

    for (const chunk of chunkText(text)) {
      aibot.sendText(chunk);
    }
  }

  async function sendMarkdown(md: string): Promise<void> {
    if (!aibot) return;

    for (const chunk of chunkText(md)) {
      aibot.sendMarkdown(chunk);
    }
  }

  async function sendImage(base64: string, md5: string): Promise<void> {
    if (!aibot) return;
    aibot.sendImage(base64, md5);
  }

  // ------------------------------------------------------------------------
  // 配置
  // ------------------------------------------------------------------------
  async function setup(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || setupDone) return;
    setupDone = true;

    const webhookUrl = await ctx.ui.input(
      "Webhook URL",
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
    );
    if (!webhookUrl) {
      setupDone = false;
      return;
    }

    const secret = await ctx.ui.input("加签密钥(可选)", "");

    config = {
      webhookUrl: webhookUrl.trim(),
      secret: secret.trim() || undefined,
      enabled: true,
    };

    await saveConfig(config);
    ctx.ui.notify("✅ 配置已保存", "success");

    // 停止旧连接，启动新连接
    stopBot();
    await startBot(ctx);

    setupDone = false;
  }

  // ------------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------------
  pi.registerTool({
    name: "wecombot_attach",
    label: "WeCom Attach",
    description: "发送文件到企业微信群",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_ATTACHMENTS }),
    }),
    async execute(_id, params) {
      const added: string[] = [];

      for (const p of params.paths) {
        if ((await stat(p)).isFile()) {
          added.push(p);
        }
      }

      if (activeMessage && aibot) {
        for (const filePath of added) {
          const mime = guessMimeType(filePath);
          if (isImage(mime)) {
            const buf = await readFile(filePath);
            await sendImage(buf.toString("base64"), buf.toString("hex").slice(0, 32));
          } else {
            await sendText(`📎 ${basename(filePath)}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: `已加入 ${added.length} 个附件` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "WeCom Send",
    description: "发送消息到企业微信群",
    parameters: Type.Object({
      message: Type.String(),
      type: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("markdown")])
      ),
    }),
    async execute(_id, params) {
      if (!aibot) {
        throw new Error("机器人未连接");
      }

      try {
        if (params.type === "markdown") {
          await sendMarkdown(params.message);
        } else {
          await sendText(params.message);
        }
        return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
      } catch (err) {
        throw new Error(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  // ------------------------------------------------------------------------
  // 命令
  // ------------------------------------------------------------------------
  pi.registerCommand("wecom-bot-setup", {
    description: "配置企业微信机器人",
    handler: async (_args, ctx) => {
      await setup(ctx);
    },
  });

  pi.registerCommand("wecom-bot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("❌ 未配置", "warning");
      } else {
        const key = config.webhookUrl.split("key=")[1]?.slice(0, 8) || "unknown";
        ctx.ui.notify(`${connected ? "✅" : "⚡"} ${key}...`, "info");
      }
    },
  });

  pi.registerCommand("wecom-bot-test", {
    description: "发送测试消息",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("请先配置", "warning");
        return;
      }
      await sendText(`🧪 ${new Date().toLocaleString("zh-CN")} | pi-wecom 测试`);
      ctx.ui.notify("✅ 已发送", "success");
    },
  });

  // ------------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------------
  pi.on("session_start", async (_e, ctx) => {
    config = await readConfig();
    await mkdir(TEMP_DIR, { recursive: true });

    if (config.enabled && config.webhookUrl) {
      await startBot(ctx);
    }
    status(ctx);
  });

  pi.on("session_shutdown", () => {
    stopBot();
  });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + SYSTEM_PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    activeMessage = null;
    status(ctx);

    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg || msg.role !== "assistant") return;

    const text = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!text) return;

    if (text.includes("```") || text.startsWith("#")) {
      await sendMarkdown(text);
    } else {
      await sendText(text);
    }
  });

  return { config };
}
