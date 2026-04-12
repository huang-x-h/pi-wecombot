/**
 * wecombot
 * 
 * 企业微信智能机器人 WebSocket 长连接扩展 for pi
 * 支持多人同时对话
 * 
 * 参考: https://developer.work.weixin.qq.com/document/path/101463
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { WSClient, generateReqId } from "aibot-node-sdk";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Config
// ============================================================================

interface Config {
  botId?: string;
  secret?: string;
  agentId?: string;
  enabled?: boolean;
}

interface Session {
  frame: any;
  streamId: string;
  userId: string;
  chatId: string;
  timestamp: number;
}

const CONFIG = join(homedir(), ".pi", "agent", "wecom-bot.json");
const TEMP = join(homedir(), ".pi", "agent", "tmp", "wecom-bot");

const PROMPT = `
[wecom-bot] 企业微信机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到对应用户的会话
- 使用 wecombot_attach 发送文件`;

// ============================================================================
// Utils
// ============================================================================

function ext(name: string): string {
  const e = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
    mp3: "audio/mpeg", pdf: "application/pdf", txt: "text/plain",
  };
  return map[e] || "application/octet-stream";
}

function isImg(m: string): boolean { return m.startsWith("image/"); }

async function load(): Promise<Config> {
  try { return JSON.parse(await readFile(CONFIG, "utf8")); }
  catch { return {}; }
}

async function save(c: Config) {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let cfg: Config = {};
  let ws: WSClient | null = null;
  let connected = false;
  let lastReqId = ""; // 记录最后一个 req_id 用于回复

  // 会话管理：reqId -> Session
  const sessions = new Map<string, Session>();

  // 清理过期会话（10分钟无活动）
  const SESSION_TTL = 10 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [reqId, session] of sessions) {
      if (now - session.timestamp > SESSION_TTL) {
        sessions.delete(reqId);
        console.log(`[wecom-bot] 清理过期会话: ${reqId.slice(0, 8)}`);
      }
    }
  }, 60000);

  // Status bar
  function setStatus(ctx: ExtensionContext, msg?: string) {
    const t = ctx.ui.theme;
    const tag = t.fg("accent", "🤖");
    if (msg) ctx.ui.setStatus("wecom", `${tag} ${t.fg("error", msg)}`);
    else if (!cfg.botId) ctx.ui.setStatus("wecom", `${tag} ${t.fg("muted", "未配置")}`);
    else ctx.ui.setStatus("wecom", `${tag} ${t.fg(connected ? "success" : "warning", connected ? `✅ (${sessions.size})` : "⚡")}`);
  }

  // 回复指定会话
  function replyTo(reqId: string, content: string, isEnd = true) {
    if (!ws || !connected) return;
    const session = sessions.get(reqId);
    if (!session) {
      console.log(`[wecom-bot] 会话不存在: ${reqId.slice(0, 8)}`);
      return;
    }
    ws.replyStream(session.frame, session.streamId, content, isEnd);
  }

  // 获取用户标识
  function getUserTag(session: Session): string {
    return session.userId || "unknown";
  }

  // Connect
  async function connect(ctx: ExtensionContext) {
    if (!cfg.botId || !cfg.secret) return;
    disconnect();

    console.log("[wecom-bot] 连接中...");

    ws = new WSClient({
      botId: cfg.botId,
      secret: cfg.secret,
    });

    ws.on("connected", () => {
      console.log("[wecom-bot] ✅ WebSocket已连接");
      connected = true;
      setStatus(ctx);
    });

    ws.on("authenticated", () => {
      console.log("[wecom-bot] ✅ 认证成功");
      connected = true;
      setStatus(ctx);
    });

    // 文本消息
    ws.on("message.text", (frame: any) => {
      const content = frame.body?.text?.content || "";
      if (!content) return;

      const reqId = frame.headers?.req_id || generateReqId("msg");
      const userId = frame.body?.from?.userid || "unknown";
      const chatId = frame.body?.chatid || "";
      const chatType = frame.body?.chattype || "single";

      console.log(`[wecom-bot] [${userId}] ${content.slice(0, 30)}`);

      // 创建新会话
      const streamId = generateReqId("stream");
      sessions.set(reqId, {
        frame,
        streamId,
        userId,
        chatId,
        timestamp: Date.now(),
      });
      lastReqId = reqId; // 记录用于回复

      // 发送思考中...
      replyTo(reqId, "🤔 思考中...", false);

      // 转发给 pi，包含用户信息
      pi.sendUserMessage([{
        type: "text",
        text: `[wecom-bot] [${userId}]\n${content}`,
      }]);
    });

    // 图片消息
    ws.on("message.image", (frame: any) => {
      const url = frame.body?.image?.url;
      const reqId = frame.headers?.req_id || generateReqId("msg");
      if (url) {
        const userId = frame.body?.from?.userid || "unknown";
        console.log(`[wecom-bot] [${userId}] 收到图片`);
        
        sessions.set(reqId, {
          frame,
          streamId: generateReqId("stream"),
          userId,
          chatId: frame.body?.chatid || "",
          timestamp: Date.now(),
        });

        pi.sendUserMessage([{
          type: "text",
          text: `[wecom-bot] [${userId}] 发送了图片: ${url}`,
        }]);
      }
    });

    // 进入会话
    ws.on("event.enter_chat", (frame: any) => {
      const userName = frame.body?.from_info?.user_name || "用户";
      console.log(`[wecom-bot] [${userName}] 进入会话`);
      
      // 发送欢迎语
      const reqId = frame.headers?.req_id || generateReqId("enter");
      ws.replyWelcome(frame, {
        msgtype: "text",
        text: {
          content: `👋 你好 ${userName}！我是 AI 助手，有什么可以帮你的吗？`,
        },
      });
    });

    ws.on("disconnected", (reason) => {
      console.log(`[wecom-bot] ❌ 断开: ${reason}`);
      connected = false;
      sessions.clear();
      setStatus(ctx);
    });

    ws.on("error", (err) => {
      console.log("[wecom-bot] ❌", err);
      connected = false;
      setStatus(ctx, String(err));
    });

    ws.connect();
  }

  function disconnect() {
    sessions.clear();
    if (ws) {
      ws.disconnect();
      ws = null;
    }
    connected = false;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  pi.registerTool({
    name: "wecombot_attach",
    label: "发送文件",
    description: "发送本地文件到企业微信",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
      reqId: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      if (!ws || !connected) {
        throw new Error("机器人未连接");
      }

      const files: string[] = [];
      for (const fp of p.paths) {
        if ((await stat(fp)).isFile()) files.push(fp);
      }

      // 指定会话或最近会话
      const reqId = p.reqId || sessions.keys().next().value;
      if (!reqId) throw new Error("无活跃会话");

      for (const fp of files) {
        const mt = ext(fp);
        if (isImg(mt)) {
          const buf = await readFile(fp);
          replyTo(reqId, `📎 ${basename(fp)}`, false);
        } else {
          replyTo(reqId, `📎 ${basename(fp)}`, false);
        }
      }

      return { content: [{ type: "text", text: `已添加 ${files.length} 个文件` }], details: {} };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "发送消息",
    description: "发送消息到企业微信",
    parameters: Type.Object({
      message: Type.String(),
      reqId: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      if (!ws || !connected) throw new Error("机器人未连接");
      
      const reqId = p.reqId || sessions.keys().next().value;
      if (!reqId) throw new Error("无活跃会话");

      replyTo(reqId, p.message, true);
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  pi.registerCommand("wecombot-setup", {
    description: "配置企业微信机器人",
    handler: async (_args, ctx) => {
      const botId = await ctx.ui.input("BotID", "wwxxxxxxxxxxxxxxx");
      if (!botId) return;

      const secret = await ctx.ui.input("Secret", "");
      if (!secret) return;

      const agentId = await ctx.ui.input("AgentID(可选)", "");

      cfg = {
        botId: botId.trim(),
        secret: secret.trim(),
        agentId: agentId?.trim() || undefined,
        enabled: true,
      };
      await save(cfg);
      ctx.ui.notify("✅ 配置已保存", "success");
      await connect(ctx);
    },
  });

  pi.registerCommand("wecombot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      if (!cfg.botId) {
        ctx.ui.notify("❌ 未配置", "warning");
      } else {
        ctx.ui.notify(`${connected ? "✅" : "⚡"} ${sessions.size} 个活跃会话`, "info");
      }
    },
  });

  pi.registerCommand("wecombot-sessions", {
    description: "查看所有会话",
    handler: async (_args, ctx) => {
      if (sessions.size === 0) {
        ctx.ui.notify("暂无活跃会话", "info");
      } else {
        const list = Array.from(sessions.entries())
          .map(([reqId, s]) => `${s.userName || s.userId}: ${reqId.slice(0, 8)}...`)
          .join("\n");
        ctx.ui.notify(`活跃会话:\n${list}`, "info");
      }
    },
  });

  pi.registerCommand("wecombot-test", {
    description: "发送测试消息",
    handler: async (_args, ctx) => {
      if (!ws || !connected) { ctx.ui.notify("请先配置", "warning"); return; }
      ctx.ui.notify("⚠️ 请 @机器人 发送消息触发测试", "warning");
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    cfg = await load();
    await mkdir(TEMP, { recursive: true });
    if (cfg.enabled && cfg.botId && cfg.secret) await connect(ctx);
    setStatus(ctx);
  });

  pi.on("session_shutdown", () => { disconnect(); });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus(ctx);

    // 使用最后收到的 req_id 进行回复
    if (!lastReqId || !sessions.has(lastReqId)) {
      console.log("[wecom-bot] 无可回复的会话");
      return;
    }

    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;

    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;

    // 提取实际回复内容（去掉标签）
    const replyContent = txt.replace(/\[wecom-bot\] \[([^\]]+)\]\n?/g, "");

    // 回复
    replyTo(lastReqId, replyContent, true);
    console.log(`[wecom-bot] 回复: ${replyContent.slice(0, 50)}`);
  });
}
