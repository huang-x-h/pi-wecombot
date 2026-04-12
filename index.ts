/**
 * pi-wecom
 * 
 * 企业微信(WeCom) DM bridge for pi
 * 
 * 基于 pi-telegram 架构设计
 * 参考: https://github.com/badlogic/pi-telegram
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Type Definitions
// ============================================================================

interface WeComConfig {
  corpId?: string;
  agentId?: string;
  corpSecret?: string;
  webhookUrl?: string;
  allowedUserId?: string;
  token?: string;
  aesKey?: string;
  lastUpdateId?: number;
}

interface WeComApiResponse<T = unknown> {
  errcode: number;
  errmsg: string;
  result?: T;
}

interface WeComUser {
  userid: string;
  name: string;
  department: number[];
}

interface WeComMessage {
  msgId: string;
  fromUserName: string;
  toUserName: string;
  msgType: string;
  content: string;
  createTime: number;
}

interface PendingWeComTurn {
  userId: string;
  replyToMessageId: string;
  queuedAttachments: QueuedAttachment[];
  content: Array<TextContent | ImageContent>;
  historyText: string;
}

type ActiveWeComTurn = PendingWeComTurn;

interface QueuedAttachment {
  path: string;
  fileName: string;
}

interface DownloadedFile {
  path: string;
  fileName: string;
  isImage: boolean;
  mimeType?: string;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG_PATH = join(homedir(), ".pi", "agent", "wecom.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "wecom");
const WECOM_PREFIX = "[wecom]";
const MAX_MESSAGE_LENGTH = 2048; // 企业微信消息长度限制
const MAX_ATTACHMENTS_PER_TURN = 10;
const MAX_RETRY_COUNT = 3;
const TOKEN_EXPIRE_BUFFER = 60000; // token过期前1分钟刷新

const SYSTEM_PROMPT_SUFFIX = `

企业微信桥接扩展已激活。
- 从企业微信转发的消息会以 "[wecom]" 前缀标记。
- [wecom] 消息可能包含企业微信附件的本地文件路径。需要时读取这些文件。
- 如果企业微信用户请求文件或生成的产物，请使用 telegram_attach 工具并附带本地文件路径，以便扩展可以在下次回复时发送。
- 不要假设在纯文本中提及本地文件路径就会将其发送到企业微信，必须使用 telegram_attach。`;

// ============================================================================
// Helper Functions
// ============================================================================

function isWeComPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(WECOM_PREFIX);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback;
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/wav") return ".wav";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "application/pdf") return ".pdf";
  return fallback;
}

function guessMediaType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flushCurrent = (): void => {
    if (current.trim().length > 0) chunks.push(current);
    current = "";
  };

  const splitLongBlock = (block: string): string[] => {
    if (block.length <= MAX_MESSAGE_LENGTH) return [block];
    const lines = block.split("\n");
    const lineChunks: string[] = [];
    let lineCurrent = "";

    for (const line of lines) {
      const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = candidate;
        continue;
      }
      if (lineCurrent.length > 0) {
        lineChunks.push(lineCurrent);
        lineCurrent = "";
      }
      if (line.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = line;
        continue;
      }
      // 超长行，按长度分割
      for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
        lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
      }
    }
    if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
    return lineChunks;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const parts = splitLongBlock(paragraph);
    for (const part of parts) {
      const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        current = candidate;
      } else {
        flushCurrent();
        current = part;
      }
    }
  }
  flushCurrent();
  return chunks;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// ============================================================================
// Config Management
// ============================================================================

async function readConfig(): Promise<WeComConfig> {
  try {
    const content = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeConfig(config: WeComConfig): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

// ============================================================================
// Main Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let config: WeComConfig = {};
  let queuedWeComTurns: PendingWeComTurn[] = [];
  let activeWeComTurn: ActiveWeComTurn | undefined;
  let currentAbort: (() => void) | undefined;
  let preserveQueuedTurnsAsHistory = false;
  let setupInProgress = false;
  let accessToken: string | undefined;
  let tokenExpireTime = 0;

  // ============================================================================
  // Status Management
  // ============================================================================

  function updateStatus(ctx: ExtensionContext, error?: string): void {
    const theme = ctx.ui.theme;
    const label = theme.fg("accent", "wecom");
    if (error) {
      ctx.ui.setStatus("wecom", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
      return;
    }
    if (!config.corpId || !config.agentId || !config.corpSecret) {
      ctx.ui.setStatus("wecom", `${label} ${theme.fg("muted", "not configured")}`);
      return;
    }
    if (!config.allowedUserId) {
      ctx.ui.setStatus("wecom", `${label} ${theme.fg("warning", "awaiting pairing")}`);
      return;
    }
    if (activeWeComTurn || queuedWeComTurns.length > 0) {
      const queued = queuedWeComTurns.length > 0 ? theme.fg("muted", ` +${queuedWeComTurns.length} queued`) : "";
      ctx.ui.setStatus("wecom", `${label} ${theme.fg("accent", "processing")}${queued}`);
      return;
    }
    ctx.ui.setStatus("wecom", `${label} ${theme.fg("success", "connected")}`);
  }

  // ============================================================================
  // WeCom API
  // ============================================================================

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < tokenExpireTime) {
      return accessToken;
    }

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${config.corpId}&corpsecret=${config.corpSecret}`;
    const response = await fetch(url);
    const data = (await response.json()) as WeComApiResponse;

    if (data.errcode !== 0) {
      throw new Error(`获取access_token失败: ${data.errmsg}`);
    }

    accessToken = data.result!.access_token;
    tokenExpireTime = Date.now() + (data.result!.expires_in - 60) * 1000;
    return accessToken;
  }

  async function callWeComApi<T>(
    method: string,
    body: Record<string, unknown>,
    retries = MAX_RETRY_COUNT
  ): Promise<T> {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/${method}?access_token=${token}`;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json()) as WeComApiResponse<T>;

        if (data.errcode === 40014 || data.errcode === 42001) {
          // token过期或无效，重新获取并重试
          accessToken = undefined;
          const newToken = await getAccessToken();
          const retryUrl = `https://qyapi.weixin.qq.com/cgi-bin/${method}?access_token=${newToken}`;
          const retryResponse = await fetch(retryUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const retryData = (await retryResponse.json()) as WeComApiResponse<T>;
          if (retryData.errcode !== 0) {
            throw new Error(retryData.errmsg);
          }
          return retryData.result!;
        }

        if (data.errcode !== 0) {
          throw new Error(data.errmsg);
        }
        return data.result!;
      } catch (error) {
        if (attempt === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw new Error("重试次数耗尽");
  }

  async function sendTextMessage(userId: string, content: string): Promise<void> {
    const chunks = chunkText(content);
    for (const chunk of chunks) {
      await callWeComApi("message/send", {
        touser: userId,
        msgtype: "text",
        agentid: Number(config.agentId),
        text: { content: chunk },
      });
    }
  }

  async function sendMarkdownMessage(userId: string, content: string): Promise<void> {
    const chunks = chunkText(content);
    for (const chunk of chunks) {
      await callWeComApi("message/send", {
        touser: userId,
        msgtype: "markdown",
        agentid: Number(config.agentId),
        markdown: { content: chunk },
      });
    }
  }

  async function sendNewsMessage(userId: string, articles: Array<{
    title: string;
    description: string;
    url: string;
    picurl: string;
  }>): Promise<void> {
    await callWeComApi("message/send", {
      touser: userId,
      msgtype: "news",
      agentid: Number(config.agentId),
      news: { articles },
    });
  }

  async function uploadFile(filePath: string): Promise<string> {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=file`;
    
    const buffer = await readFile(filePath);
    const form = new FormData();
    form.set("media", new Blob([buffer]), basename(filePath));

    const response = await fetch(url, {
      method: "POST",
      body: form,
    });
    const data = (await response.json()) as WeComApiResponse<{ media_id: string }>;

    if (data.errcode !== 0) {
      throw new Error(`上传文件失败: ${data.errmsg}`);
    }
    return data.result!.media_id;
  }

  async function sendFileMessage(userId: string, filePath: string): Promise<void> {
    const mediaId = await uploadFile(filePath);
    await callWeComApi("message/send", {
      touser: userId,
      msgtype: "file",
      agentid: Number(config.agentId),
      file: { media_id: mediaId },
    });
  }

  async function sendImageMessage(userId: string, filePath: string): Promise<void> {
    const token = await getAccessToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`;
    
    const buffer = await readFile(filePath);
    const form = new FormData();
    form.set("media", new Blob([buffer]), basename(filePath));

    const response = await fetch(url, {
      method: "POST",
      body: form,
    });
    const data = (await response.json()) as WeComApiResponse<{ media_id: string }>;

    if (data.errcode !== 0) {
      throw new Error(`上传图片失败: ${data.errmsg}`);
    }

    await callWeComApi("message/send", {
      touser: userId,
      msgtype: "image",
      agentid: Number(config.agentId),
      image: { media_id: data.result!.media_id },
    });
  }

  // ============================================================================
  // Config Setup
  // ============================================================================

  async function promptForConfig(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || setupInProgress) return;
    setupInProgress = true;

    try {
      // 1. 获取企业ID
      const corpId = await ctx.ui.input("企业微信 CorpID", "wwxxxxxxxxxxxxxxxx");
      if (!corpId) return;

      // 2. 获取应用AgentID
      const agentId = await ctx.ui.input("企业微信 AgentId", "1000002");
      if (!agentId) return;

      // 3. 获取应用Secret
      const corpSecret = await ctx.ui.input("企业微信 Agent Secret", "xxxxxxxxxxxxxxxxxxxx");
      if (!corpSecret) return;

      // 4. 验证配置
      const nextConfig: WeComConfig = {
        corpId: corpId.trim(),
        agentId: agentId.trim(),
        corpSecret: corpSecret.trim(),
      };

      // 测试获取access_token
      try {
        const token = await getAccessToken.call({
          accessToken: undefined,
          tokenExpireTime: 0,
          config: nextConfig,
        });
        nextConfig.corpId = nextConfig.corpId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`配置验证失败: ${message}`, "error");
        return;
      }

      config = nextConfig;
      await writeConfig(config);
      ctx.ui.notify("企业微信配置完成！", "success");
      ctx.ui.notify("在企业微信中向应用发送消息以完成配对。", "info");
      updateStatus(ctx);
    } finally {
      setupInProgress = false;
    }
  }

  // ============================================================================
  // Turn Management
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

  async function createWeComTurn(
    content: Array<TextContent | ImageContent>,
    userId: string,
    historyTurns: PendingWeComTurn[] = []
  ): Promise<PendingWeComTurn> {
    let prompt = WECOM_PREFIX;

    if (historyTurns.length > 0) {
      prompt += `\n\nEarlier messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
      for (const [index, turn] of historyTurns.entries()) {
        prompt += `\n\n${index + 1}. ${turn.historyText}`;
      }
      prompt += `\n\nCurrent message:`;
    }

    // 提取文本内容
    const textParts: string[] = [];
    const imageContents: ImageContent[] = [];
    
    for (const item of content) {
      if (item.type === "text") {
        textParts.push(item.text);
      } else if (item.type === "image") {
        imageContents.push(item);
      }
    }

    const rawText = textParts.join("\n\n");
    if (historyTurns.length > 0 || rawText.length > 0) {
      prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
    }

    const finalContent: Array<TextContent | ImageContent> = [{ type: "text", text: prompt }];
    
    // 添加图片
    for (const img of imageContents) {
      finalContent.push(img);
    }

    return {
      userId,
      replyToMessageId: "",
      queuedAttachments: [],
      content: finalContent,
      historyText: rawText || "(no text)",
    };
  }

  async function sendQueuedAttachments(turn: ActiveWeComTurn): Promise<void> {
    for (const attachment of turn.queuedAttachments) {
      try {
        const mediaType = guessMediaType(attachment.path);
        if (mediaType && isImageMimeType(mediaType)) {
          await sendImageMessage(turn.userId, attachment.path);
        } else {
          await sendFileMessage(turn.userId, attachment.path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sendTextMessage(turn.userId, `发送附件失败 ${attachment.fileName}: ${message}`);
      }
    }
  }

  async function dispatchWeComMessage(
    userId: string,
    content: string,
    ctx: ExtensionContext
  ): Promise<void> {
    const lower = content.toLowerCase().trim();

    // 处理内置命令
    if (lower === "stop" || lower === "/stop") {
      if (currentAbort) {
        if (queuedWeComTurns.length > 0) {
          preserveQueuedTurnsAsHistory = true;
        }
        currentAbort();
        updateStatus(ctx);
        await sendTextMessage(userId, "已中止当前任务。");
      } else {
        await sendTextMessage(userId, "没有正在执行的任务。");
      }
      return;
    }

    if (lower === "/status") {
      let totalInput = 0;
      let totalOutput = 0;
      let totalCost = 0;

      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        totalInput += entry.message.usage.input;
        totalOutput += entry.message.usage.output;
        totalCost += entry.message.usage.cost.total;
      }

      const usage = ctx.getContextUsage();
      const lines: string[] = [];
      if (ctx.model) {
        lines.push(`模型: ${ctx.model.provider}/${ctx.model.id}`);
      }
      if (totalInput) lines.push(`输入: ${formatTokens(totalInput)}`);
      if (totalOutput) lines.push(`输出: ${formatTokens(totalOutput)}`);
      if (lines.length === 0) lines.push("暂无使用数据。");

      await sendTextMessage(userId, lines.join("\n"));
      return;
    }

    if (lower === "/help" || lower === "/start") {
      await sendTextMessage(
        userId,
        `发送消息给我，我会将其转发到 pi。\n\n可用命令:\n/status - 显示使用统计\n/stop - 停止当前任务\n/help - 显示此帮助`
      );
      
      // 首次配对
      if (config.allowedUserId === undefined) {
        config.allowedUserId = userId;
        await writeConfig(config);
        updateStatus(ctx);
        await sendTextMessage(userId, "企业微信桥接已与此账户配对成功！");
      }
      return;
    }

    // 创建任务
    const historyTurns = preserveQueuedTurnsAsHistory ? queuedWeComTurns.splice(0) : [];
    preserveQueuedTurnsAsHistory = false;
    const turn = await createWeComTurn(
      [{ type: "text", text: content }],
      userId,
      historyTurns
    );
    queuedWeComTurns.push(turn);

    if (ctx.isIdle()) {
      updateStatus(ctx);
      pi.sendUserMessage(turn.content);
    }
  }

  // ============================================================================
  // Register Tools
  // ============================================================================

  pi.registerTool({
    name: "telegram_attach",
    label: "WeCom Attach",
    description: "将本地文件加入队列，在下次回复时通过企业微信发送。",
    promptSnippet: "将本地文件加入队列，通过企业微信发送。",
    promptGuidelines: [
      "当处理 [wecom] 消息且用户请求文件或生成的产物时，调用 telegram_attach 并附带本地文件路径。",
    ],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "要发送的本地文件路径" }),
        { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }
      ),
    }),
    async execute(_toolCallId, params) {
      if (!activeWeComTurn) {
        throw new Error("telegram_attach 只能在回复企业微信消息时使用");
      }

      const added: string[] = [];
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) {
          throw new Error(`不是文件: ${inputPath}`);
        }
        if (activeWeComTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
          throw new Error(`附件数量已达上限 (${MAX_ATTACHMENTS_PER_TURN})`);
        }
        activeWeComTurn.queuedAttachments.push({
          path: inputPath,
          fileName: basename(inputPath),
        });
        added.push(inputPath);
      }

      return {
        content: [{ type: "text", text: `已加入 ${added.length} 个附件到队列。` }],
        details: { paths: added },
      };
    },
  });

  // ============================================================================
  // Register Commands
  // ============================================================================

  pi.registerCommand("wecom-setup", {
    description: "配置企业微信应用凭证",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.registerCommand("wecom-status", {
    description: "显示企业微信桥接状态",
    handler: async (_args, ctx) => {
      const status = [
        `应用ID: ${config.agentId || "未配置"}`,
        `企业ID: ${config.corpId || "未配置"}`,
        `允许用户: ${config.allowedUserId || "未配对"}`,
        `活跃任务: ${activeWeComTurn ? "是" : "否"}`,
        `排队任务: ${queuedWeComTurns.length}`,
      ];
      ctx.ui.notify(status.join(" | "), "info");
    },
  });

  pi.registerCommand("wecom-send", {
    description: "向企业微信用户发送消息",
    handler: async (args, ctx) => {
      if (!config.corpId) {
        ctx.ui.notify("请先运行 /wecom-setup 配置企业微信", "warning");
        return;
      }

      const [userId, ...messageParts] = args.split(" ");
      const message = messageParts.join(" ");

      if (!userId || !message) {
        ctx.ui.notify("用法: /wecom-send <用户ID> <消息内容>", "warning");
        return;
      }

      try {
        await sendTextMessage(userId, message);
        ctx.ui.notify(`消息已发送给 ${userId}`, "success");
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`发送失败: ${errMsg}`, "error");
      }
    },
  });

  pi.registerCommand("wecom-broadcast", {
    description: "通过群机器人发送消息（需配置webhook）",
    handler: async (args, ctx) => {
      if (!config.webhookUrl) {
        ctx.ui.notify("请先在配置中设置企业微信群机器人Webhook URL", "warning");
        return;
      }

      if (!args) {
        ctx.ui.notify("用法: /wecom-broadcast <消息内容>", "warning");
        return;
      }

      // 注意：群机器人需要使用不同的API端点
      ctx.ui.notify("群机器人功能开发中...", "info");
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
    queuedWeComTurns = [];
    activeWeComTurn = undefined;
    currentAbort = undefined;
    preserveQueuedTurnsAsHistory = false;
  });

  pi.on("before_agent_start", async (event) => {
    const suffix = isWeComPrompt(event.prompt)
      ? `${SYSTEM_PROMPT_SUFFIX}\n- 当前用户消息来自企业微信。`
      : SYSTEM_PROMPT_SUFFIX;
    return {
      systemPrompt: event.systemPrompt + suffix,
    };
  });

  pi.on("agent_start", async (_event, ctx) => {
    currentAbort = () => ctx.abort();
    if (!activeWeComTurn && queuedWeComTurns.length > 0) {
      const nextTurn = queuedWeComTurns.shift();
      if (nextTurn) {
        activeWeComTurn = { ...nextTurn };
      }
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const turn = activeWeComTurn;
    currentAbort = undefined;
    activeWeComTurn = undefined;
    updateStatus(ctx);

    if (!turn) return;

    const assistant = extractAssistantText(event.messages);

    if (assistant.stopReason === "aborted") {
      return;
    }

    if (assistant.stopReason === "error") {
      await sendTextMessage(
        turn.userId,
        assistant.errorMessage || "处理请求时发生错误。"
      );
      return;
    }

    if (assistant.text) {
      await sendMarkdownMessage(turn.userId, assistant.text);
    }

    // 发送附件
    if (turn.queuedAttachments.length > 0) {
      await sendQueuedAttachments(turn);
    }
  });

  // ============================================================================
  // Message Handler (for manual trigger / webhook)
  // ============================================================================

  /**
   * 手动触发处理企业微信消息
   * 可通过webhook接收或命令触发
   */
  async function handleWeComMessage(
    userId: string,
    content: string,
    ctx: ExtensionContext
  ): Promise<void> {
    // 验证用户
    if (config.allowedUserId && userId !== config.allowedUserId) {
      await sendTextMessage(userId, "此应用未授权给您使用。");
      return;
    }

    // 首次配对
    if (config.allowedUserId === undefined) {
      config.allowedUserId = userId;
      await writeConfig(config);
      updateStatus(ctx);
      await sendTextMessage(userId, "企业微信桥接已与此账户配对成功！");
    }

    await dispatchWeComMessage(userId, content, ctx);
  }

  // 暴露给外部的接口
  return {
    handleWeComMessage,
    sendTextMessage,
    sendMarkdownMessage,
    sendNewsMessage,
  };
}
