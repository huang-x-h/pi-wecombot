/**
 * pi-wecom-bot
 * 
 * 企业微信群机器人长连接(WebSocket) bridge extension for pi
 * 
 * 参考: https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocket } from "node:ws";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Type Definitions
// ============================================================================

interface WeComBotConfig {
  webhookUrl?: string;      // Webhook URL（用于提取key）
  secret?: string;         // 加签密钥
  enabled?: boolean;
}

interface WeComRobotMessage {
  msgId: string;
  robotCode: string;
  openChatId: string;
  content: string;
  fromUsername?: string;
  createTime: number;
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
const WSS_BASE_URL = "wss://qyapi.weixin.qq.com/wvp/session/longconnection";
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
  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeMessage: { content: Array<TextContent | ImageContent> } | null = null;
  let messageHandler: ((msg: WeComRobotMessage) => void) | null = null;
  let setupDone = false;

  // ------------------------------------------------------------------------
  // Status
  // ------------------------------------------------------------------------
  function status(ctx: ExtensionContext, msg?: string): void {
    const t = ctx.ui.theme;
    const label = t.fg("accent", "wecom-bot");
    
    if (msg) {
      ctx.ui.setStatus("wecom-bot", `${label} ${t.fg("error", msg)}`);
      return;
    }
    
    if (!config.webhookUrl) {
      ctx.ui.setStatus("wecom-bot", `${label} ${t.fg("muted", "not configured")}`);
      return;
    }
    
    const connected = ws?.readyState === 1;
    ctx.ui.setStatus("wecom-bot", `${label} ${t.fg(connected ? "success" : "warning", connected ? "✅" : "⚡")} ${config.enabled ? "" : t.fg("muted", "(disabled)")}`);
  }

  // ------------------------------------------------------------------------
  // WebSocket 长连接
  // ------------------------------------------------------------------------
  async function connect(ctx: ExtensionContext): Promise<void> {
    if (!config.webhookUrl) return;

    const url = new URL(config.webhookUrl);
    const key = url.searchParams.get("key");
    if (!key) {
      console.log("[wecom-bot] 需要有效的webhook key");
      return;
    }

    const wssUrl = `${WSS_BASE_URL}?key=${key}&passback=pi-wecom`;
    console.log("[wecom-bot] 正在连接...");

    try {
      ws = new WebSocket(wssUrl);

      ws.on("open", () => {
        console.log("[wecom-bot] ✅ 已连接");
        status(ctx);
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log("[wecom-bot] 收到:", JSON.stringify(msg).slice(0, 100));
          
          const robotMsg: WeComRobotMessage = {
            msgId: msg.msgid || randomUUID(),
            robotCode: msg.robot_code || "",
            openChatId: msg.open_chat_id || "",
            content: msg.content || msg.text?.content || "",
            fromUsername: msg.from_username,
            createTime: msg.create_time || Math.floor(Date.now() / 1000),
          };

          if (messageHandler && robotMsg.content) {
            messageHandler(robotMsg);
          }
        } catch (e) {
          console.log("[wecom-bot] 解析失败:", e);
        }
      });

      ws.on("close", (code) => {
        console.log(`[wecom-bot] 连接断开: ${code}`);
        ws = null;
        status(ctx);
        if (config.enabled) scheduleReconnect(ctx);
      });

      ws.on("error", (err) => {
        console.log("[wecom-bot] 错误:", err.message);
        status(ctx, err.message);
      });

    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.log("[wecom-bot] 连接失败:", err);
      scheduleReconnect(ctx);
    }
  }

  function disconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close(1000, "正常关闭");
    ws = null;
  }

  function scheduleReconnect(ctx: ExtensionContext): void {
    reconnectTimer = setTimeout(() => {
      if (config.enabled) connect(ctx);
    }, 5000);
  }

  function wsSend(data: Record<string, unknown>): boolean {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // 消息发送
  // ------------------------------------------------------------------------
  function send(message: Record<string, unknown>): void {
    const ok = wsSend(message);
    if (!ok) {
      console.log("[wecom-bot] 发送失败: 未连接");
    }
  }

  async function sendText(text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      send({ msgtype: "text", text: { content: chunk } });
    }
  }

  async function sendMarkdown(md: string): Promise<void> {
    for (const chunk of chunkText(md)) {
      send({ msgtype: "markdown", markdown: { content: chunk } });
    }
  }

  async function sendImage(base64: string, md5: string): Promise<void> {
    send({ msgtype: "image", image: { base64, md5 } });
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
    if (!webhookUrl) { setupDone = false; return; }

    const secret = await ctx.ui.input("加签密钥(可选)", "");
    
    config = {
      webhookUrl: webhookUrl.trim(),
      secret: secret.trim() || undefined,
      enabled: true,
    };

    await saveConfig(config);
    ctx.ui.notify("✅ 配置已保存", "success");
    ctx.ui.notify("正在连接机器人...", "info");
    
    await connect(ctx);
    status(ctx);
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
        if ((await stat(p)).isFile()) added.push(p);
      }

      if (activeMessage) {
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

      return { content: [{ type: "text", text: `已加入 ${added.length} 个附件` }], details: {} };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "WeCom Send",
    description: "发送消息到企业微信群",
    parameters: Type.Object({
      message: Type.String(),
      type: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("markdown")])),
    }),
    async execute(_id, params) {
      if (!ws || ws.readyState !== 1) throw new Error("机器人未连接");
      try {
        if (params.type === "markdown") await sendMarkdown(params.message);
        else await sendText(params.message);
        return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
      } catch (e) {
        throw new Error(`发送失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // ------------------------------------------------------------------------
  // 命令
  // ------------------------------------------------------------------------
  pi.registerCommand("wecom-bot-setup", {
    description: "配置企业微信机器人",
    handler: async (_args, ctx) => { await setup(ctx); },
  });

  pi.registerCommand("wecom-bot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("❌ 未配置", "warning");
      } else {
        const key = config.webhookUrl.split("key=")[1]?.slice(0, 8) || "unknown";
        const connected = ws?.readyState === 1;
        ctx.ui.notify(`${connected ? "✅" : "⚡"} ${key}... | ${config.enabled ? "启用" : "禁用"}`, "info");
      }
    },
  });

  pi.registerCommand("wecom-bot-test", {
    description: "发送测试消息",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) { ctx.ui.notify("请先配置", "warning"); return; }
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
    if (config.enabled && config.webhookUrl) await connect(ctx);
    status(ctx);
  });

  pi.on("session_shutdown", () => { disconnect(); });

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

  return { config, status };
}
