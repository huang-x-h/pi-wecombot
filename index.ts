/**
 * wecombot
 * 
 * 企业微信智能机器人 WebSocket 长连接扩展 for pi
 * 使用官方 aibot-node-sdk
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

const CONFIG = join(homedir(), ".pi", "agent", "wecom-bot.json");
const TEMP = join(homedir(), ".pi", "agent", "tmp", "wecom-bot");

const PROMPT = `
[wecom-bot] 企业微信机器人已连接
- 收到 @机器人 的消息会自动处理
- 回复会自动发送到群聊
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

function chunk(s: string, n = 4000): string[] {
  if (s.length <= n) return [s];
  const r: string[] = [];
  for (let i = 0; i < s.length; i += n) r.push(s.slice(i, i + n));
  return r;
}

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
  let lastFrame: any = null;
  let lastStreamId = "";

  // Status bar
  function setStatus(ctx: ExtensionContext, msg?: string) {
    const t = ctx.ui.theme;
    const tag = t.fg("accent", "🤖");
    if (msg) ctx.ui.setStatus("wecom", `${tag} ${t.fg("error", msg)}`);
    else if (!cfg.botId) ctx.ui.setStatus("wecom", `${tag} ${t.fg("muted", "未配置")}`);
    else ctx.ui.setStatus("wecom", `${tag} ${t.fg(connected ? "success" : "warning", connected ? "✅" : "⚡")}`);
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
      if (content) {
        console.log("[wecom-bot] 收到:", content.slice(0, 50));
        lastFrame = frame;
        lastStreamId = generateReqId("stream");
        pi.sendUserMessage([{ type: "text", text: `[wecom-bot] ${content}` }]);
      }
    });

    // 图片消息
    ws.on("message.image", (frame: any) => {
      const url = frame.body?.image?.url;
      if (url) {
        console.log("[wecom-bot] 收到图片:", url);
      }
    });

    ws.on("disconnected", (reason) => {
      console.log(`[wecom-bot] ❌ 断开: ${reason}`);
      connected = false;
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
    if (ws) {
      ws.disconnect();
      ws = null;
    }
    connected = false;
    lastFrame = null;
  }

  // Reply - 使用 replyStream
  function sendReply(content: string, isEnd = true) {
    if (!ws || !connected || !lastFrame) {
      console.log("[wecom-bot] 无法回复: 未连接或无上下文");
      return;
    }
    ws.replyStream(lastFrame, lastStreamId, content, isEnd);
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
    }),
    async execute(_id, p) {
      if (!ws || !connected) {
        throw new Error("机器人未连接");
      }

      const files: string[] = [];
      for (const fp of p.paths) {
        if ((await stat(fp)).isFile()) files.push(fp);
      }

      for (const fp of files) {
        const mt = ext(fp);
        if (isImg(mt)) {
          const buf = await readFile(fp);
          // 使用主动发送媒体
          ws.sendMediaMessage(lastFrame?.body?.from_info?.userid || "", "image", buf.toString("base64"), {
            md5: buf.toString("hex").slice(0, 32),
          });
        } else {
          // 先发送文本
          if (lastFrame) {
            sendReply(`📎 ${basename(fp)}`);
          }
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
      type: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("markdown"),
      ])),
    }),
    async execute(_id, p) {
      if (!ws || !connected) throw new Error("机器人未连接");
      
      if (lastFrame) {
        // 回复到触发消息的会话
        sendReply(p.message, true);
      } else {
        throw new Error("无可用会话上下文");
      }
      
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
      if (!cfg.botId) ctx.ui.notify("❌ 未配置", "warning");
      else ctx.ui.notify(`${connected ? "✅" : "⚡"} ${cfg.botId.slice(0, 8)}...`, "info");
    },
  });

  pi.registerCommand("wecombot-test", {
    description: "发送测试消息",
    handler: async (_args, ctx) => {
      if (!ws || !connected) { ctx.ui.notify("请先配置", "warning"); return; }
      // 发送测试需要先收到消息
      ctx.ui.notify("⚠️ 请先 @机器人 发送消息", "warning");
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
    
    if (!lastFrame || !ws || !connected) {
      console.log("[wecom-bot] 无上下文，跳过回复");
      return;
    }

    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;
    
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;

    // 使用 replyStream 发送回复
    sendReply(txt, true);
  });
}
