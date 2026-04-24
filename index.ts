/**
 * pi-wecombot
 * 
 * 企业微信智能机器人 WebSocket 长连接扩展 for pi
 * 支持多个机器人配置和快速切换
 * 
 * 参考: https://developer.work.weixin.qq.com/document/path/101463
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

// 全局配置：所有会话共享机器人列表
interface GlobalConfig {
  bots: BotConfig[];
}

// 会话配置：每个会话独立选择启用哪个机器人
interface SessionConfig {
  activeBotId?: string;  // 当前会话启用的机器人
  enabled?: boolean;     // 当前会话是否启用
}

interface Session {
  frame: any;
  streamId: string;
  userId: string;
  chatId: string;
  timestamp: number;
  botId: string;
}

// 待处理消息项
interface PendingMessage {
  reqId: string;
  type: string;
  text: string;
}

// ============================================================================
// Session Utils
// ============================================================================

// 获取会话唯一标识 - 使用环境变量或生成唯一ID
function getSessionId(): string {
  // 优先使用 pi 提供的环境变量
  if (process.env.PI_SESSION_ID) return process.env.PI_SESSION_ID;
  if (process.env.PI_INSTANCE_ID) return process.env.PI_INSTANCE_ID;
  
  // 备用：使用时间戳+随机数，确保唯一性
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `sess-${timestamp}-${random}`;
}

// 获取全局配置路径（机器人列表，所有会话共享）
function getGlobalConfigPath(): string {
  return join(homedir(), ".pi", "agent", "wecom-bot.json");
}

// 获取会话专属配置路径（会话选择哪个机器人，会话独立）
function getSessionConfigPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", `wecom-bot-session-${sessionId}.json`);
}

// 获取会话专属临时目录
function getSessionTempPath(sessionId: string): string {
  return join(homedir(), ".pi", "agent", "tmp", "wecom-bot", sessionId);
}

// 全局变量
let SESSION_ID: string;
let GLOBAL_CONFIG: string;
let SESSION_CONFIG: string;
let TEMP: string;

const PROMPT = `
[wecom-bot] 企业微信机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到对应用户的会话
- 使用 wecombot-attach 发送文件`;

// ============================================================================
// Config Management
// ============================================================================

// 加载全局配置（机器人列表）
async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const data = JSON.parse(await readFile(GLOBAL_CONFIG, "utf8"));
    return { bots: data.bots || [] };
  } catch {
    return { bots: [] };
  }
}

// 保存全局配置（机器人列表）
async function saveGlobalConfig(c: GlobalConfig) {
  await mkdir(dirname(GLOBAL_CONFIG), { recursive: true });
  await writeFile(GLOBAL_CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

// 加载会话配置（会话选择的机器人和启用状态）
async function loadSessionConfig(): Promise<SessionConfig> {
  try {
    const data = JSON.parse(await readFile(SESSION_CONFIG, "utf8"));
    return { activeBotId: data.activeBotId, enabled: data.enabled ?? true };
  } catch {
    return { enabled: true };
  }
}

// 保存会话配置
async function saveSessionConfig(c: SessionConfig) {
  await mkdir(dirname(SESSION_CONFIG), { recursive: true });
  await writeFile(SESSION_CONFIG, JSON.stringify(c, null, "\t") + "\n");
}

function getActiveBot(bots: BotConfig[], activeBotId?: string): BotConfig | undefined {
  return bots.find(b => b.botId === activeBotId) || bots[0];
}

function getBotById(bots: BotConfig[], botId: string): BotConfig | undefined {
  return bots.find(b => b.botId === botId);
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 初始化路径
  SESSION_ID = getSessionId();
  GLOBAL_CONFIG = getGlobalConfigPath();
  SESSION_CONFIG = getSessionConfigPath(SESSION_ID);
  TEMP = getSessionTempPath(SESSION_ID);
  
  console.log(`[wecombot] 会话ID: ${SESSION_ID.slice(0, 8)}`);
  console.log(`[wecombot] 全局配置: ${GLOBAL_CONFIG}`);
  console.log(`[wecombot] 会话配置: ${SESSION_CONFIG}`);
  
  // 全局机器人列表（从全局配置加载）
  let globalBots: BotConfig[] = [];
  // 会话配置（本会话选择哪个机器人）
  let sessionCfg: SessionConfig = { enabled: true };
  
  let ws: WSClient | null = null;
  let connected = false;

  const sessions = new Map<string, Session>();
  
  // 待处理消息队列，每条消息关联 reqId
  const pendingMessages: PendingMessage[] = [];
  let isProcessing = false;
  let currentReqId: string | null = null;  // 当前正在处理的 reqId
  
  // 处理消息队列
  async function processMessageQueue() {
    if (isProcessing || pendingMessages.length === 0) return;
    isProcessing = true;
    
    // 取出队首消息（不删除，等 AI 回复后再删除）
    const message = pendingMessages[0];
    if (!message) {
      isProcessing = false;
      return;
    }
    
    // 检查会话是否还存在
    if (!sessions.has(message.reqId)) {
      // 会话已过期，移除并处理下一条
      console.log(`[wecombot] 会话 ${message.reqId.slice(0, 8)} 已过期，跳过`);
      pendingMessages.shift();
      isProcessing = false;
      processMessageQueue();
      return;
    }
    
    currentReqId = message.reqId;
    
    try {
      // @ts-ignore
      await pi.sendUserMessage([{ type: "text", text: message.text }]);
      console.log(`[wecombot] 消息已发送: reqId=${message.reqId.slice(0, 8)}, 队列剩余=${pendingMessages.length - 1}`);
    } catch (err: any) {
      if (err?.message?.includes('already processing')) {
        console.log('[wecombot] Agent 忙，消息将在 500ms 后重试');
        currentReqId = null;
      } else {
        console.error('[wecombot] 发送消息失败:', err);
        pendingMessages.shift();  // 移除失败消息
        currentReqId = null;
      }
    }
    
    isProcessing = false;
    
    // 如果没有错误，等待 agent_end 后再处理下一条
    if (currentReqId === null && pendingMessages.length > 0) {
      setTimeout(processMessageQueue, 500);
    }
  }
  
  // 发送消息到队列（关联 reqId）
  function queueMessage(reqId: string, text: string) {
    pendingMessages.push({ reqId, type: "text", text });
    console.log(`[wecombot] 消息入队: reqId=${reqId.slice(0, 8)}, 队列长度=${pendingMessages.length}`);
    processMessageQueue();
  }

  // 清理过期会话
  setInterval(() => {
    const now = Date.now();
    for (const [reqId, session] of sessions) {
      if (now - session.timestamp > 10 * 60 * 1000) {
        sessions.delete(reqId);
      }
    }
  }, 60000);

  // Status - 已连接后才显示，未连接时不显示
  function setStatus(ctx: ExtensionContext, msg?: string) {
    const active = getActiveBot(globalBots, sessionCfg.activeBotId);
    
    // 已连接才显示状态栏
    if (!connected) {
      ctx.ui.setStatus("wecombot", "");
      return;
    }
    
    const botName = active?.name || active?.botId.slice(0, 8) || "企微";
    
    if (msg) {
      // 有错误信息时显示
      ctx.ui.setStatus("wecombot", `${botName}【wecom】🔴 ${msg}`);
    } else {
      // 已连接
      ctx.ui.setStatus("wecombot", `${botName}【wecom】✅ ${sessions.size}`);
    }
  }

  // 回复
  function replyTo(reqId: string, content: string, isEnd = true) {
    if (!ws || !connected) return;
    const session = sessions.get(reqId);
    if (!session) return;
    ws.replyStream(session.frame, session.streamId, content, isEnd);
  }

  // 连接 - 添加错误保护
  async function connect(ctx: ExtensionContext, bot: BotConfig): Promise<boolean> {
    try {
      disconnect();

      console.log(`[wecombot] 连接中: ${bot.name || bot.botId}`);
      console.log(`[wecombot] ⚠️ 提示: 同一机器人只能有一个连接，其他会话将被断开`);

      ws = new WSClient({ botId: bot.botId, secret: bot.secret });

      ws.on("connected", () => {
        console.log(`[wecombot] ✅ ${bot.name || bot.botId} 已连接`);
        connected = true;
        setStatus(ctx);
      });

      ws.on("authenticated", () => {
        console.log(`[wecombot] ✅ ${bot.name || bot.botId} 认证成功`);
        connected = true;
        setStatus(ctx);
      });

      ws.on("message.text", (frame: any) => {
        const content = frame.body?.text?.content || "";
        if (!content) return;

        const reqId = frame.headers?.req_id || generateReqId("msg");
        const userId = frame.body?.from?.userid || "unknown";
        const chatId = frame.body?.chatid || "";
        const botId = bot.botId;
        const botName = bot.name;

        console.log(`[wecombot] [${botName || botId}] [${userId}] ${content.slice(0, 30)}`);

        sessions.set(reqId, { frame, streamId: generateReqId("stream"), userId, chatId, timestamp: Date.now(), botId });

        replyTo(reqId, "🤔 思考中...", false);
        // 消息关联 reqId 入队
        queueMessage(reqId, `[wecombot] [${botName || botId}] [${userId}]\n${content}`);
      });

      ws.on("message.image", (frame: any) => {
        const url = frame.body?.image?.url;
        const reqId = frame.headers?.req_id || generateReqId("msg");
        if (url) {
          const userId = frame.body?.from?.userid || "unknown";
          sessions.set(reqId, { frame, streamId: generateReqId("stream"), userId, chatId: frame.body?.chatid || "", timestamp: Date.now(), botId: bot.botId });
          // 图片消息也关联 reqId
          queueMessage(reqId, `[wecombot] [${bot.name || bot.botId}] [${userId}] 发送了图片: ${url}`);
        }
      });

      ws.on("event.enter_chat", (frame: any) => {
        ws && ws.replyWelcome(frame, { msgtype: "text", text: { content: `👋 你好！我是 ${bot.name || "AI"} 助手，有什么可以帮你的吗？` } });
      });

      ws.on("disconnected", (reason?: string) => {
        const wasConnected = connected;
        connected = false;
        sessions.clear();
        
        const isKicked = reason?.includes("kick") || reason?.includes("replaced") || reason === "connection replaced";
        const disconnectMsg = isKicked ? `被其他会话踢掉` : `断开`;
        
        console.log(`[wecombot] ❌ ${bot.name || bot.botId} ${disconnectMsg}${reason ? `: ${reason}` : ""}`);
        
        if (wasConnected && isKicked) {
          setStatus(ctx, `被其他会话连接 (${SESSION_ID.slice(0, 4)})`);
        } else {
          setStatus(ctx);
        }
      });

      ws.on("error", (err: any) => {
        const errMsg = String(err);
        console.log(`[wecombot] ❌ ${bot.name || bot.botId}`, err);
        connected = false;
        
        if (errMsg.includes("already connected") || errMsg.includes("connection refused")) {
          setStatus(ctx, "连接被占用");
          ctx.ui.notify(`❌ ${bot.name || bot.botId} 连接失败：该机器人已在其他会话连接`, "error");
        } else {
          setStatus(ctx, errMsg);
        }
      });

      ws.connect();
      return true;
    } catch (err) {
      console.error(`[wecombot] 连接异常:`, err);
      connected = false;
      setStatus(ctx, "连接异常");
      return false;
    }
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
      const reqId = sessions.keys().next().value;
      if (!reqId) throw new Error("无活跃会话");
      const files: string[] = [];
      for (const fp of p.paths) if ((await stat(fp)).isFile()) files.push(fp);
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

  // 【全局配置】添加机器人 - 所有会话可见
  pi.registerCommand("wecombot-add", {
    description: "添加机器人（全局）",
    handler: async (_args, ctx) => {
      const name = await ctx.ui.input("机器人名称(可选)", "");
      const botId = await ctx.ui.input("BotID", "wwxxxxxxxxxxxxxxx");
      if (!botId) return;
      const secret = await ctx.ui.input("Secret", "");
      if (!secret) return;

      const globalCfg = await loadGlobalConfig();
      
      if (globalCfg.bots.find(b => b.botId === botId.trim())) {
        ctx.ui.notify("❌ 该机器人已存在", "error");
        return;
      }
      
      globalCfg.bots.push({ 
        botId: botId.trim(), 
        secret: secret.trim(), 
        name: name?.trim() || undefined 
      });
      await saveGlobalConfig(globalCfg);
      
      globalBots = globalCfg.bots;
      
      if (!sessionCfg.activeBotId) {
        sessionCfg.activeBotId = botId.trim();
        sessionCfg.enabled = true;
        await saveSessionConfig(sessionCfg);
      }
      
      ctx.ui.notify(`✅ 已添加 ${name || botId.slice(0, 8)}（全局配置）`, "info");
      
      const newBot = globalBots[globalBots.length - 1];
      await connect(ctx, newBot);
    },
  });

  // 【全局配置】列出所有机器人
  pi.registerCommand("wecombot-list", {
    description: "列出所有机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("全局暂无配置的机器人", "info");
      } else {
        const list = globalBots.map(b => {
          const isSessionActive = b.botId === sessionCfg.activeBotId ? "▶" : "○";
          const isConnected = connected && b.botId === sessionCfg.activeBotId ? "✅" : "";
          return `${isSessionActive} ${isConnected} ${b.name || b.botId}`;
        }).join("\n");
        const sessionInfo = sessionCfg.activeBotId ? `本会话启用: ${getActiveBot(globalBots, sessionCfg.activeBotId)?.name || sessionCfg.activeBotId}` : "本会话未启用机器人";
        ctx.ui.notify(`全局机器人列表（共 ${globalBots.length} 个）: ${list}${sessionInfo}`, "info");
      }
    },
  });

  // 【会话配置】切换当前会话启用的机器人
  pi.registerCommand("wecombot-use", {
    description: "切换机器人（本会话）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人，请先添加", "warning");
        return;
      }
      
      const options = globalBots.map(b => 
        `${b.botId === sessionCfg.activeBotId ? "▶ " : "○ "}${b.name || b.botId}`
      );
      
      const selected = await ctx.ui.select("选择机器人（仅本会话）", options);
      if (!selected) return;
      
      const selectedLabel = selected.replace(/^[▶○] /, "");
      const bot = globalBots.find(b => b.botId === selectedLabel || (b.name || b.botId) === selectedLabel);
      if (!bot) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      sessionCfg.activeBotId = bot.botId;
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      ctx.ui.notify(`✅ 本会话已切换到 ${bot.name || bot.botId}`, "info");
      await connect(ctx, bot);
    },
  });

  // 【全局配置】删除机器人
  pi.registerCommand("wecombot-remove", {
    description: "删除机器人（全局）",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      if (globalBots.length === 0) {
        ctx.ui.notify("暂无配置的机器人", "warning");
        return;
      }
      
      const name = await ctx.ui.input("输入要删除的BotID或名称", "");
      if (!name) return;

      const idx = globalBots.findIndex(b => b.botId === name || b.name === name);
      if (idx === -1) {
        ctx.ui.notify("❌ 机器人不存在", "error");
        return;
      }

      const removed = globalBots.splice(idx, 1)[0];
      
      await saveGlobalConfig({ bots: globalBots });
      
      if (sessionCfg.activeBotId === removed.botId) {
        disconnect();
        sessionCfg.activeBotId = globalBots[0]?.botId;
        await saveSessionConfig(sessionCfg);
        
        if (globalBots.length > 0) {
          ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}，自动切换到下一个`, "info");
          const nextBot = getActiveBot(globalBots, sessionCfg.activeBotId);
          if (nextBot && sessionCfg.enabled) await connect(ctx, nextBot);
        } else {
          ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}（无可用机器人）`, "info");
        }
      } else {
        ctx.ui.notify(`✅ 已删除 ${removed.name || removed.botId}`, "info");
      }
    },
  });

  // 【混合】状态查看
  pi.registerCommand("wecombot-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (!active) {
        ctx.ui.notify(
          `全局机器人: ${globalBots.length} 个
本会话状态: 未选择机器人`,
          "info"
        );
        return;
      }
      
      let statusIcon: string;
      let statusText: string;
      
      if (!sessionCfg.enabled) {
        statusIcon = "🔴";
        statusText = "已禁用";
      } else if (connected) {
        statusIcon = "✅";
        statusText = "已连接";
      } else {
        statusIcon = "❌";
        statusText = "已断开";
      }
      
      ctx.ui.notify(
        `${statusIcon} ${active.name || active.botId}
状态: ${statusText}
全局机器人: ${globalBots.length} 个
本会话活跃会话: ${sessions.size} 个
会话ID: ${SESSION_ID.slice(0, 8)}`,
        "info"
      );
    },
  });

  // 【会话配置】启用本会话连接
  pi.registerCommand("wecombot-enable", {
    description: "启用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是启用状态", "info");
        return;
      }
      sessionCfg.enabled = true;
      await saveSessionConfig(sessionCfg);
      
      const bot = getActiveBot(globalBots, sessionCfg.activeBotId);
      if (bot) {
        await connect(ctx, bot);
        ctx.ui.notify(`✅ 本会话已启用并连接 ${bot.name || bot.botId}`, "info");
      } else {
        ctx.ui.notify("✅ 本会话已启用，但未选择机器人，请先添加或使用 /wecombot-use 选择", "warning");
      }
      setStatus(ctx);
    },
  });

  // 【会话配置】禁用本会话连接
  pi.registerCommand("wecombot-disable", {
    description: "禁用机器人（本会话）",
    handler: async (_args, ctx) => {
      if (!sessionCfg.enabled) {
        ctx.ui.notify("本会话机器人已是禁用状态", "info");
        return;
      }
      sessionCfg.enabled = false;
      await saveSessionConfig(sessionCfg);
      disconnect();
      ctx.ui.notify("🔌 本会话已禁用机器人并断开连接", "info");
      setStatus(ctx);
    },
  });

  // 【会话】查看会话详情
  pi.registerCommand("wecombot-session", {
    description: "查看当前会话详情",
    handler: async (_args, ctx) => {
      if (sessions.size === 0) {
        ctx.ui.notify("暂无活跃会话", "info");
        return;
      }
      const active = getActiveBot(globalBots, sessionCfg.activeBotId);
      const sessionList = Array.from(sessions.entries()).map(([reqId, s]) => 
        `[${active?.name || s.botId}]
  reqId: ${reqId}
  userId: ${s.userId}
  chatId: ${s.chatId}`
      ).join("\n\n");
      ctx.ui.notify(`当前会话:
${sessionList}`, "info");
    },
  });

  // 【会话】查看会话信息
  pi.registerCommand("wecombot-session-info", {
    description: "查看会话信息",
    handler: async (_args, ctx) => {
      const info = [
        `会话ID: ${SESSION_ID}`,
        `全局配置: ${GLOBAL_CONFIG}`,
        `会话配置: ${SESSION_CONFIG}`,
        `临时目录: ${TEMP}`,
        ``,
        `【全局】机器人数量: ${globalBots.length}`,
        `【会话】启用机器人: ${sessionCfg.activeBotId || "无"}`,
        `【会话】启用状态: ${sessionCfg.enabled ? "✅" : "🔴"}`,
        `【会话】连接状态: ${connected ? "🟢 已连接" : "⚪ 未连接"}`,
        `【会话】活跃消息会话: ${sessions.size} 个`,
      ].join("\n");
      ctx.ui.notify(info, "info");
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    try {
      // 加载全局机器人列表
      const globalCfg = await loadGlobalConfig();
      globalBots = globalCfg.bots;
      
      // 加载本会话配置
      sessionCfg = await loadSessionConfig();
      
      await mkdir(TEMP, { recursive: true });
      
      // 如果启用了且选择了机器人，则尝试连接（失败不影响 pi）
      if (sessionCfg.enabled && sessionCfg.activeBotId) {
        const bot = getBotById(globalBots, sessionCfg.activeBotId);
        if (bot) {
          const success = await connect(ctx, bot);
          if (!success) {
            console.log(`[wecombot] 连接失败，但不影响 pi 使用`);
          }
        }
      }
      // 注意：不调用 setStatus，连接过程中 ws.on('connected') 会自动调用
    } catch (err) {
      console.error(`[wecombot] session_start 异常:`, err);
      // 不影响 pi 启动
    }
  });

  pi.on("session_shutdown", () => { 
    try {
      disconnect(); 
    } catch (err) {
      console.error(`[wecombot] session_shutdown 异常:`, err);
    }
  });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus(ctx);
    
    // 检查当前是否有正在处理的消息
    if (!currentReqId || pendingMessages.length === 0) return;
    
    // 确认是当前请求的回复
    const pending = pendingMessages[0];
    if (pending.reqId !== currentReqId) return;
    
    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) {
      // 没有回复内容，移除消息并继续处理下一条
      pendingMessages.shift();
      currentReqId = null;
      processMessageQueue();
      return;
    }
    
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) {
      pendingMessages.shift();
      currentReqId = null;
      processMessageQueue();
      return;
    }
    
    const active = getActiveBot(globalBots, sessionCfg.activeBotId);
    const pattern = new RegExp(`\\[wecombot\\] \\[${active?.name || active?.botId || ""}\\] \\[([^\\]]+)\\]\\n?`, "g");
    const replyContent = txt.replace(pattern, "");
    
    // 回复给对应的用户
    if (replyContent.trim()) {
      replyTo(pending.reqId, replyContent, true);
      console.log(`[wecombot] 回复: reqId=${pending.reqId.slice(0, 8)}, 内容=${replyContent.slice(0, 50)}`);
    }
    
    // 移除已处理的消息
    pendingMessages.shift();
    currentReqId = null;
    
    // 处理下一条消息
    processMessageQueue();
  });
}
