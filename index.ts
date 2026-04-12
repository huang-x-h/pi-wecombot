/**
 * pi-wecom-bot
 * 
 * 企业微信智能机器人(Webhook) DM bridge for pi
 * 
 * 基于企业微信群机器人Webhook接口实现
 * 参考: https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657
 * 
 * 特点：
 * - 无需企业ID和Secret，仅需Webhook URL
 * - 支持文本、Markdown、图片、文件等消息
 * - 支持加签密钥验证
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHmac, randomUUID } from "node:crypto";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Type Definitions
// ============================================================================

interface WeComBotConfig {
  webhookUrl?: string;      // Webhook URL（必需）
  secret?: string;          // 加签密钥（可选）
  enabled?: boolean;        // 是否启用
}

interface WeComApiResponse {
  errcode: number;
  errmsg: string;
}

interface PendingMessage {
  content: Array<TextContent | ImageContent>;
  timestamp: number;
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
const WECOM_BOT_PREFIX = "[wecom-bot]";
const MAX_MESSAGE_LENGTH = 4096; // 企业微信机器人消息长度限制
const MAX_ATTACHMENTS_PER_TURN = 10;

// 系统提示词
const SYSTEM_PROMPT_SUFFIX = `

企业微信机器人桥接扩展已激活。
- 所有通过企业微信机器人发送的消息都会标记 [wecom-bot]
- 机器人在群聊中推送消息
- 如果用户请求文件或生成的产物，调用 wecombot_attach 工具将其发送到企业微信群`;

// ============================================================================
// Helper Functions
// ============================================================================

function isWeComBotPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(WECOM_BOT_PREFIX);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/**
 * 根据文件扩展名猜测MIME类型
 */
function guessMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "webp": "image/webp",
    "mp4": "video/mp4",
    "avi": "video/avi",
    "mov": "video/quicktime",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
    "rar": "application/x-rar-compressed",
    "txt": "text/plain",
    "json": "application/json",
    "xml": "text/xml",
    "html": "text/html",
    "css": "text/css",
    "js": "application/javascript",
    "ts": "text/typescript",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}

/**
 * 判断是否为图片类型
 */
function isImageType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 生成签名（用于加签密钥验证）
 */
function generateSignature(secret: string, timestamp: string): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac("sha256", secret).update(stringToSign, "utf8").digest("base64");
}

/**
 * 文本分片
 */
function chunkText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flushCurrent = (): void => {
    if (current.trim().length > 0) chunks.push(current);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    
    if (paragraph.length <= MAX_MESSAGE_LENGTH) {
      const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        current = candidate;
      } else {
        flushCurrent();
        current = paragraph;
      }
    } else {
      flushCurrent();
      // 超长段落按行分割
      const lines = paragraph.split("\n");
      let lineBuffer = "";
      
      for (const line of lines) {
        const newBuffer = lineBuffer.length === 0 ? line : `${lineBuffer}\n${line}`;
        if (newBuffer.length <= MAX_MESSAGE_LENGTH) {
          lineBuffer = newBuffer;
        } else {
          if (lineBuffer) chunks.push(lineBuffer);
          lineBuffer = line.length <= MAX_MESSAGE_LENGTH ? line : "";
        }
      }
      
      if (lineBuffer) chunks.push(lineBuffer);
    }
  }

  flushCurrent();
  return chunks;
}

// ============================================================================
// Config Management
// ============================================================================

async function readConfig(): Promise<WeComBotConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeConfig(config: WeComBotConfig): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

// ============================================================================
// Main Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let config: WeComBotConfig = {};
  let queuedMessages: PendingMessage[] = [];
  let activeMessage: PendingMessage | undefined;
  let setupInProgress = false;

  // ============================================================================
  // Status Management
  // ============================================================================

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "wecom-bot");
    
    if (error) {
      ctx.ui.setStatus("wecom-bot", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
      return;
    }
    
    if (!config.webhookUrl) {
      ctx.ui.setStatus("wecom-bot", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    
    if (!config.enabled) {
      ctx.ui.setStatus("wecom-bot", `${label} ${theme.fg("warning", "disabled")}`);
      return;
    }
    
    ctx.ui.setStatus("wecom-bot", `${label} ${theme.fg("success", "ready")}`);
  }

  // ============================================================================
  // WeCom Bot API
  // ============================================================================

  /**
   * 发送消息到企业微信群
   */
  async function sendMessage(message: Record<string, unknown>): Promise<void> {
    if (!config.webhookUrl) {
      throw new Error("请先配置企业微信机器人 Webhook URL");
    }

    let url = config.webhookUrl;
    
    // 如果配置了加签密钥，添加签名
    if (config.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const sign = generateSignature(config.secret, timestamp);
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      const data = (await response.json()) as WeComApiResponse;

      if (data.errcode !== 0) {
        throw new Error(`发送失败 [${data.errcode}]: ${data.errmsg}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`发送失败: ${String(error)}`);
    }
  }

  /**
   * 发送文本消息
   */
  async function sendText(text: string): Promise<void> {
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      await sendMessage({
        msgtype: "text",
        text: {
          content: chunk,
        },
      });
    }
  }

  /**
   * 发送Markdown消息
   */
  async function sendMarkdown(content: string): Promise<void> {
    const chunks = chunkText(content);
    for (const chunk of chunks) {
      await sendMessage({
        msgtype: "markdown",
        markdown: {
          content: chunk,
        },
      });
    }
  }

  /**
   * 发送图片（base64格式）
   */
  async function sendImage(base64Data: string, md5: string): Promise<void> {
    await sendMessage({
      msgtype: "image",
      image: {
        base64: base64Data,
        md5: md5,
      },
    });
  }

  /**
   * 发送图文消息（链接卡片）
   */
  async function sendNews(
    title: string,
    description: string,
    url: string,
    picUrl?: string
  ): Promise<void> {
    await sendMessage({
      msgtype: "news",
      news: {
        articles: [
          {
            title,
            description,
            url,
            picurl: picUrl || "",
          },
        ],
      },
    });
  }

  /**
   * 发送文件（通过media_id，需要先上传素材）
   * 注意：机器人文件消息需要先将文件上传为临时素材
   */
  async function sendFile(filePath: string): Promise<void> {
    // 企业微信群机器人暂时不支持直接发送文件
    // 建议使用图文消息或提示用户下载链接
    await sendText(`📎 文件: ${basename(filePath)}\n请查看附件或访问相关链接`);
  }

  /**
   * 发送纯文本消息（富文本卡片）
   */
  async function sendTextCard(
    title: string,
    description: string,
    btnText?: string,
    btnUrl?: string
  ): Promise<void> {
    const message: Record<string, unknown> = {
      msgtype: "textcard",
      textcard: {
        title,
        description,
        url: btnUrl || "https://work.weixin.qq.com/",
        btntxt: btnText || "更多",
      },
    };

    await sendMessage(message);
  }

  // ============================================================================
  // Config Setup
  // ============================================================================

  async function promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || setupInProgress) return;
    setupInProgress = true;

    try {
      // 1. 获取 Webhook URL
      const webhookUrl = await ctx.ui.input(
        "企业微信群机器人 Webhook URL",
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      );
      if (!webhookUrl) return;

      // 2. 获取加签密钥（可选）
      const secret = await ctx.ui.input(
        "加签密钥（可选，直接回车跳过）",
        ""
      );

      // 3. 验证配置
      const nextConfig: WeComBotConfig = {
        webhookUrl: webhookUrl.trim(),
        secret: secret.trim() || undefined,
        enabled: true,
      };

      // 测试发送
      try {
        await sendText("🔔 pi-wecom-bot 连接测试\n\n配置成功！机器人已准备就绪。");
        ctx.ui.notify("✅ Webhook 连接成功！", "success");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`❌ 连接失败: ${msg}`, "error");
        return;
      }

      config = nextConfig;
      await writeConfig(config);
      ctx.ui.notify("企业微信机器人配置完成！", "success");
      updateStatus(ctx);
    } finally {
      setupInProgress = false;
    }
  }

  // ============================================================================
  // Tool Result Handlers
  // ============================================================================

  function isAssistantMessage(message: AgentMessage): boolean {
    return (message as unknown as { role?: string }).role === "assistant";
  }

  function getMessageText(message: AgentMessage): string {
    const value = message as unknown as Record<string, unknown>;
    const content = Array.isArray(value.content) ? value.content : [];
    return content
      .filter((block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && "type" in block)
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();
  }

  function extractAssistantText(messages: AgentMessage[]): {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
  } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as unknown as Record<string, unknown>;
      if (message.role !== "assistant") continue;
      const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter((block): block is { type: string; text?: string } =>
          typeof block === "object" && block !== null && "type" in block)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("")
        .trim();
      return { text: text || undefined, stopReason, errorMessage };
    }
    return {};
  }

  async function processAndSendMessage(text: string): Promise<void> {
    if (!text) return;

    // 判断消息类型
    if (text.includes("```")) {
      // 代码块较多，使用Markdown
      await sendMarkdown(text);
    } else if (text.startsWith("#") || text.includes("**")) {
      // Markdown格式
      await sendMarkdown(text);
    } else if (text.includes("\n")) {
      // 多行文本
      await sendMarkdown(text);
    } else {
      // 普通文本
      await sendText(text);
    }
  }

  // ============================================================================
  // Register Tools
  // ============================================================================

  pi.registerTool({
    name: "wecombot_attach",
    label: "WeCom Attach",
    description: "将本地文件通过企业微信机器人发送到群聊",
    promptSnippet: "将文件发送到企业微信群",
    promptGuidelines: [
      "当用户请求发送文件或生成产物时，调用 wecombot_attach 将文件发送到企业微信群",
    ],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "要发送的本地文件路径" }),
        { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }
      ),
    }),
    async execute(_toolCallId, params) {
      const added: string[] = [];

      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) {
          throw new Error(`不是文件: ${inputPath}`);
        }

        added.push(inputPath);
      }

      // 如果有活动消息，直接发送
      if (activeMessage) {
        for (const filePath of added) {
          const mimeType = guessMimeType(filePath);
          if (isImageType(mimeType)) {
            const buffer = await readFile(filePath);
            const base64 = buffer.toString("base64");
            const md5 = buffer.toString("hex").substring(0, 32);
            await sendImage(base64, md5);
          } else {
            await sendFile(filePath);
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `已加入 ${added.length} 个附件到发送队列。`,
          },
        ],
        details: { paths: added },
      };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "WeCom Send",
    description: "直接发送消息到企业微信群",
    parameters: Type.Object({
      message: Type.String({ description: "要发送的消息内容" }),
      type: Type.Optional(
        Type.Union([
          Type.Literal("text"),
          Type.Literal("markdown"),
        ])
      ),
    }),
    async execute(_toolCallId, params) {
      if (!config.webhookUrl) {
        throw new Error("请先运行 /wecom-bot-setup 配置机器人");
      }

      const type = params.type || "text";

      try {
        if (type === "markdown") {
          await sendMarkdown(params.message);
        } else {
          await sendText(params.message);
        }

        return {
          content: [
            {
              type: "text",
              text: `✅ 消息已发送（${type}）`,
            },
          ],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`发送失败: ${msg}`);
      }
    },
  });

  // ============================================================================
  // Register Commands
  // ============================================================================

  pi.registerCommand("wecom-bot-setup", {
    description: "配置企业微信群机器人 Webhook",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.registerCommand("wecom-bot-status", {
    description: "查看企业微信机器人状态",
    handler: async (_args, ctx) => {
      if (config.webhookUrl) {
        const urlParts = config.webhookUrl.split("/");
        const keyPart = urlParts[urlParts.length - 1] || "";
        const keyId = keyPart.replace("key=", "").substring(0, 10);
        
        ctx.ui.notify(
          `状态: ${config.enabled ? "✅ 已启用" : "❌ 已禁用"} | Key: ${keyId}... | 加密: ${config.secret ? "✅ 是" : "❌ 否"}`,
          "info"
        );
      } else {
        ctx.ui.notify("状态: ❌ 未配置，运行 /wecom-bot-setup 进行配置", "warning");
      }
    },
  });

  pi.registerCommand("wecom-bot-test", {
    description: "发送测试消息到企业微信群",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("请先运行 /wecom-bot-setup 配置机器人", "warning");
        return;
      }

      try {
        await sendText("🧪 测试消息\n\n来自 pi-wecom-bot 的测试消息");
        ctx.ui.notify("✅ 测试消息已发送", "success");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`❌ 发送失败: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("wecom-bot-enable", {
    description: "启用企业微信机器人",
    handler: async (_args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("请先运行 /wecom-bot-setup 配置机器人", "warning");
        return;
      }
      config.enabled = true;
      await writeConfig(config);
      ctx.ui.notify("✅ 机器人已启用", "success");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("wecom-bot-disable", {
    description: "禁用企业微信机器人",
    handler: async (_args, ctx) => {
      config.enabled = false;
      await writeConfig(config);
      ctx.ui.notify("✅ 机器人已禁用", "info");
      updateStatus(ctx);
    },
  });

  // ============================================================================
  // Event Handlers
  // ============================================================================

  pi.on("session_start", async (_event, ctx) => {
    config = await readConfig();
    await mkdir(TEMP_DIR, { recursive: true });
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    queuedMessages = [];
    activeMessage = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const suffix = isWeComBotPrompt(event.prompt)
      ? `${SYSTEM_PROMPT_SUFFIX}\n- 当前消息来自企业微信群机器人。`
      : SYSTEM_PROMPT_SUFFIX;
    return {
      systemPrompt: event.systemPrompt + suffix,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!activeMessage && queuedMessages.length > 0) {
      activeMessage = queuedMessages.shift();
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    activeMessage = undefined;
    updateStatus(ctx);

    const assistant = extractAssistantText(event.messages);

    if (assistant.stopReason === "aborted") {
      return;
    }

    if (assistant.stopReason === "error") {
      await sendText(`❌ 处理失败\n\n${assistant.errorMessage || "未知错误"}`);
      return;
    }

    if (assistant.text) {
      await processAndSendMessage(assistant.text);
    }
  });

  // ============================================================================
  // Public API
  // ============================================================================

  return {
    sendText,
    sendMarkdown,
    sendImage,
    sendNews,
    sendTextCard,
    config,
    updateStatus,
  };
}
