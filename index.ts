/**
 * pi-wecombot
 * 
 * 企业微信智能机器人 WebSocket 长连接扩展 for pi
 * 支持多个机器人配置和切换
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

interface BotConfig {
  botId: string;
  secret: string;
  name?: string;
}

interface Config {
  bots: BotConfig[];
  activeBotId?: string;
  enabled?: boolean;
}

interface Session {
  frame: any;
  streamId: string;
  userId: string;
  chatId: string;
  timestamp: number;
  botId: string;
}

const CONFIG = join(homedir(), ".pi", "agent", "wecom-bot.json");
const TEMP = join(homedir(), ".pi", "agent", "tmp", "wecom-bot");

const PROMPT = `
[wecom-bot] 企业微信机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到对应用户的会话
- 使用 wecombot-attach 发送文件`;

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
  try {
    const data = JSON.parse(await readFile(CONFIG, "utf8"));
    return { bots: data.bots || [], activeBotId: data.activeBotId, enabled: data.enabled ?? true };
  }
  catch { return { bots: [], enabled: true }; }
}

async function save(c: Config) {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

function getActiveBot(cfg: Config): BotConfig | undefined {
  return cfg.bots.find(b => b.botId === cfg.activeBotId) || cfg.bots[0];
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  let cfg: Config = { bots: [], activeBotId: undefined, enabled: true };
  let ws: WSClient | null = null;
  let connected = false;
  let lastReqId = "";

  const sessions = new Map<string, Session>();

  // 清理过期会话
  setInterval(() => {
    const now = Date.now();
    for (const [reqId, session] of sessions) {
      if (now - session.timestamp > 10 * 60 * 1000) {
        sessions.delete(reqId);
      }
    }
  }, 60000);

  // Status
  function setStatus(ctx: ExtensionContext, msg?: string) {
    const t = ctx.ui.theme;
    const tag = t.fg("accent", "🤖");
    const active = getActiveBot(cfg);
    if (msg) ctx.ui.setStatus("wecombot", `${tag} ${t.fg("error", msg)}`);
    else if (!active) ctx.ui.setStatus("wecombot", `${tag} ${t.fg("muted", "未配置")}`);
    else ctx.ui.setStatus("wecombot", `${tag} ${t.fg(connected ? "success" : "warning", connected ? `✅ (${sessions.size})` : "⚡")} ${active.name || active.botId.slice(0, 8)}`);
  }

  // 回复
  function replyTo(reqId: string, content: string, isEnd = true) {
    if (!ws || !connected) return;
    const session = sessions.get(reqId);
    if (!session) return;
    ws.replyStream(session.frame, session.streamId, content, isEnd);
  }

  // Connect
  async function connect(ctx: ExtensionContext, bot?: BotConfig) {
    const target = bot || getActiveBot(cfg);
    if (!target) return;
    disconnect();

    console.log(`[wecombot] 连接中: ${target.name || target.botId}`);

    ws = new WSClient({ botId: target.botId, secret: target.secret });

    ws.on("connected", () => {
      console.log("[wecombot] ✅ 已连接");
      connected = true;
      setStatus(ctx);
    });

    ws.on("authenticated", () => {
      console.log("[wecombot] ✅ 认证成功");
      connected = true;
      setStatus(ctx);
    });

    ws.on("message.text", (frame: any) => {
      const content = frame.body?.text?.content || "";
      if (!content) return;

      const reqId = frame.headers?.req_id || generateReqId("msg");
      const userId = frame.body?.from?.userid || "unknown";
      const chatId = frame.body?.chatid || "";
      const botId = target.botId;

      console.log(`[wecombot] [${userId}] ${content.slice(0, 30)}`);

      sessions.set(reqId, { frame, streamId: generateReqId("stream"), userId, chatId, timestamp: Date.now(), botId });
      lastReqId = reqId;

      replyTo(reqId, "🤔 思考中...", false);
      pi.sendUserMessage([{ type: "text", text: `[wecombot] [${userId}]\n${content}` }]);
    });

    ws.on("message.image", (frame: any) => {
      const url = frame.body?.image?.url;
      const reqId = frame.headers?.req_id || generateReqId("msg");
      if (url) {
        const userId = frame.body?.from?.userid || "unknown";
        const botId = target.botId;
        sessions.set(reqId, { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId });
        pi.sendUserMessage([{ type: "text", text: `[wecombot] [${userId}] 发送了图片: ${url}` }]);
      }
    });

    ws.on("event.enter_chat", (frame: any) => {
      const reqId = frame.headers?.req_id || generateReqId("enter");
      ws.replyWelcome(frame, { msgtype: "text", text: { content: `👋 你好！我是 AI 助手，有什么可以帮你的吗？` } });
    });

    ws.on("disconnected", () => {
      console.log("[wecombot] ❌ 断开");
      connected = false;
      sessions.clear();
      setStatus(ctx);
    });

    ws.on("error", (err) => {
      console.log("[wecombot] ❌", err);
      connected = false;
      setStatus(ctx, String(err));
    });

    ws.connect();
  }

  function disconnect() {
    sessions.clear();
    if (ws) { ws.disconnect(); ws = null; }
    connected = false;
  }

  // ============================================================================
  // Tools
  // ============================================================================

  pi.registerTool({
    name: "wecombot-attach",
    label: "发送文件",
    description: "发送本地文件到企业微信",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_id, p) {
      if (!ws || !connected) throw new Error("机器人未连接");
      const files: string[] = [];
      for (const fp of p.paths) if ((await stat(fp)).isFile()) files.push(fp);
      const reqId = sessions.keys().next().value;
      if (!reqId) throw new Error("无活跃会话");
      for (const fp of files) replyTo(reqId, `📎 ${basename(fp)}`, false);
      return { content: [{ type: "text", text: `已添加 ${files.length} 个文件` }], details: {} };
    },
  });

  pi.registerTool({
    name: "wecombot-send",
    label: "发送消息",
    description: "发送消息到企业微信",
    parameters: Type.Object({
      message: Type.String(),
    }),
    async execute(_id, p) {
      if (!ws || !connected) throw new Error("机器人未连接");
      const reqId = sessions.keys().next().value;
      if (!reqId) throw new Error("无活跃会话");
      replyTo(reqId, p.message, true);
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  // 添加机器人
  pi.registerCommand("wecombot-add", {
    description: "添加机器人",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const botId = await ctx.ui.input("BotID", "wwxxxxxxxxxxxxxxx");
      if (!botId) return;
      const secret = await ctx.ui.input("Secret", "");
      if (!secret) return;

      cfg.bots = cfg.bots || [];
      cfg.bots.push({ botId: botId.trim(), secret: secret.trim(), name: name?.trim() || undefined });
      if (!cfg.activeBotId) cfg.activeBotId = botId.trim();
      cfg.enabled = true;
      await save(cfg);
      ctx.ui.notify(`✅ 已添加 ${name || botId.slice(0, 8)}`, "success");
      await connect(ctx);
    },
  });

  // 列出机器人
  pi.registerCommand("wecombot-list", {
    description: "列出所有机器人",
    handler: async (_args, ctx) => {
      if (cfg.bots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "info");
      } else {
        const list = cfg.bots.map(b => 
          `${b.botId === cfg.activeBotId ? "▶" : "○"} ${b.name || b.botId.slice(0, 12)}...`
        ).join("\n");
        ctx.ui.notify(`机器人列表:\n${list}`, "info");
      }
    },
  });

  // 切换机器人
  pi.registerCommand("wecombot-use", {
    description: "切换机器人",
    handler: async (_args, ctx) => {
      if (cfg.bots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      const name = await ctx.ui.input("选择机器人(BotID)", cfg.activeBotId || "");
      if (!name) return;
      
      const bot = cfg.bots.find(b => b.botId === name || b.name === name);
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      cfg.activeBotId = bot.botId;
      cfg.enabled = true;
      await save(cfg);
      ctx.ui.notify(`✅ 已切换到 ${bot.name || bot.botId.slice(0, 8)}`, "success");
      await connect(ctx, bot);
    },
  });

  // 删除机器人
  pi.registerCommand("wecombot-remove", {
    description: "删除机器人",
    handler: async (_args, ctx) => {
      if (cfg.bots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      const name = await ctx.ui.input("输入要删除的BotID", "");
      if (!name) return;

      const idx = cfg.bots.findIndex(b => b.botId === name || b.name === name);
      if (idx === -1) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      const removed = cfg.bots.splice(idx, 1)[0];
      if (cfg.activeBotId === removed.botId) {
        cfg.activeBotId = cfg.bots[0]?.botId;
      }
      await save(cfg);
      ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId.slice(0, 8)}`, "success");
      if (cfg.bots.length > 0) await connect(ctx);
      else disconnect();
    },
  });

  // 状态
  pi.registerCommand("wecombot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      const active = getActiveBot(cfg);
      if (!active) ctx.ui.notify("❌ 未配置", "warning");
      else ctx.ui.notify(`${connected ? "✅" : "⚡"} ${active.name || active.botId.slice(0, 8)} | ${sessions.size} 会话`, "info");
    },
  });

  // 开启/关闭
  pi.registerCommand("wecombot-enable", {
    description: "开启机器人",
    handler: async (_args, ctx) => {
      cfg.enabled = true;
      await save(cfg);
      const bot = getActiveBot(cfg);
      if (bot) await connect(ctx, bot);
      ctx.ui.notify("✅ 机器人已开启", "success");
    },
  });

  pi.registerCommand("wecombot-disable", {
    description: "关闭机器人",
    handler: async (_args, ctx) => {
      disconnect();
      cfg.enabled = false;
      await save(cfg);
      ctx.ui.notify("✅ 机器人已关闭", "success");
    },
  });

  // 测试
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
    if (cfg.enabled && cfg.bots.length > 0) {
      const bot = getActiveBot(cfg);
      if (bot) await connect(ctx, bot);
    }
    setStatus(ctx);
  });

  pi.on("session_shutdown", () => { disconnect(); });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus(ctx);
    if (!lastReqId || !sessions.has(lastReqId)) return;
    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;
    const replyContent = txt.replace(/\[wecombot\] \[([^\]]+)\]\n?/g, "");
    replyTo(lastReqId, replyContent, true);
    console.log(`[wecombot] 回复: ${replyContent.slice(0, 50)}`);
  });
}
