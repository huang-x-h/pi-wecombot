/**
 * pi-wecom
 * 
 * 企业微信群机器人长连接扩展 for pi
 * 
 * 使用官方 aibot-node-sdk 实现 WebSocket 长连接
 * https://developer.work.weixin.qq.com/document/path/101463
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import Aibot from "aibot-node-sdk";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ============================================================================
// Config
// ============================================================================

interface Config {
  key?: string;
  secret?: string;
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
  let bot: any = null;
  let connected = false;

  // Status bar
  function setStatus(ctx: ExtensionContext, msg?: string) {
    const t = ctx.ui.theme;
    const tag = t.fg("accent", "🤖");
    if (msg) ctx.ui.setStatus("wecom", `${tag} ${t.fg("error", msg)}`);
    else if (!cfg.key) ctx.ui.setStatus("wecom", `${tag} ${t.fg("muted", "未配置")}`);
    else ctx.ui.setStatus("wecom", `${tag} ${t.fg(connected ? "success" : "warning", connected ? "✅" : "⚡")}`);
  }

  // Connect
  async function connect(ctx: ExtensionContext) {
    if (!cfg.key) return;
    disconnect();

    console.log("[wecom] 连接中...");
    bot = new Aibot({ key: cfg.key, secret: cfg.secret });

    bot.on("onStart", () => {
      console.log("[wecom] ✅ 已连接");
      connected = true;
      setStatus(ctx);
    });

    bot.on("onMessage", (msg: any) => {
      const txt = msg.content || msg.text?.content || "";
      if (!txt) return;
      console.log("[wecom] 📥", txt.slice(0, 50));
      pi.sendUserMessage([{ type: "text", text: `[wecom] ${txt}` }]);
    });

    bot.on("onClose", () => {
      console.log("[wecom] ❌ 断开");
      connected = false;
      setStatus(ctx);
      if (cfg.enabled) setTimeout(() => connect(ctx), 5000);
    });

    bot.on("onError", (e: any) => {
      console.log("[wecom] ❌", e?.message || e);
      connected = false;
      setStatus(ctx, e?.message || "error");
    });

    bot.start();
  }

  function disconnect() {
    if (bot) { bot.stop(); bot = null; }
    connected = false;
  }

  // Send
  async function send(txt: string) {
    if (!bot) return;
    for (const s of chunk(txt)) bot.sendText(s);
  }

  async function sendMd(md: string) {
    if (!bot) return;
    for (const s of chunk(md)) bot.sendMarkdown(s);
  }

  async function sendImg(b64: string, md5: string) {
    if (!bot) return;
    bot.sendImage(b64, md5);
  }

  // ============================================================================
  // Tools
  // ============================================================================

  pi.registerTool({
    name: "wecombot_attach",
    label: "发送文件",
    description: "发送本地文件到企业微信群",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    }),
    async execute(_id, p) {
      const files: string[] = [];
      for (const fp of p.paths) {
        if ((await stat(fp)).isFile()) files.push(fp);
      }

      if (bot && files.length) {
        for (const fp of files) {
          const mt = ext(fp);
          if (isImg(mt)) {
            const buf = await readFile(fp);
            await sendImg(buf.toString("base64"), buf.toString("hex").slice(0, 32));
          } else {
            await send(`📎 ${basename(fp)}`);
          }
        }
      }

      return { content: [{ type: "text", text: `已添加 ${files.length} 个文件` }], details: {} };
    },
  });

  pi.registerTool({
    name: "wecom_send",
    label: "发送消息",
    description: "发送消息到企业微信群",
    parameters: Type.Object({
      message: Type.String(),
      type: Type.Optional(Type.Union([
        Type.Literal("text"),
        Type.Literal("markdown"),
      ])),
    }),
    async execute(_id, p) {
      if (!bot) throw new Error("机器人未连接");
      if (p.type === "markdown") await sendMd(p.message);
      else await send(p.message);
      return { content: [{ type: "text", text: "✅ 已发送" }], details: {} };
    },
  });

  // ============================================================================
  // Commands
  // ============================================================================

  pi.registerCommand("wecom-setup", {
    description: "配置企业微信机器人",
    handler: async (_args, ctx) => {
      const url = await ctx.ui.input("Webhook URL", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx");
      if (!url) return;

      const key = new URL(url).searchParams.get("key");
      if (!key) {
        ctx.ui.notify("❌ URL中未找到key", "error");
        return;
      }

      const secret = await ctx.ui.input("加签密钥(可选)", "");
      cfg = { key, secret: secret || undefined, enabled: true };
      await save(cfg);
      ctx.ui.notify("✅ 配置已保存", "success");
      await connect(ctx);
    },
  });

  pi.registerCommand("wecom-status", {
    description: "查看机器人状态",
    handler: async (_args, ctx) => {
      if (!cfg.key) {
        ctx.ui.notify("❌ 未配置", "warning");
      } else {
        ctx.ui.notify(`${connected ? "✅" : "⚡"} ${cfg.key.slice(0, 8)}...`, "info");
      }
    },
  });

  pi.registerCommand("wecom-test", {
    description: "发送测试消息",
    handler: async (_args, ctx) => {
      if (!cfg.key) {
        ctx.ui.notify("请先配置", "warning");
        return;
      }
      await send(`🧪 ${new Date().toLocaleString("zh-CN")} | pi-wecom`);
      ctx.ui.notify("✅ 已发送", "success");
    },
  });

  // ============================================================================
  // Events
  // ============================================================================

  pi.on("session_start", async (_e, ctx) => {
    cfg = await load();
    await mkdir(TEMP, { recursive: true });
    if (cfg.enabled && cfg.key) await connect(ctx);
    setStatus(ctx);
  });

  pi.on("session_shutdown", () => { disconnect(); });

  pi.on("before_agent_start", async (e) => ({
    systemPrompt: e.systemPrompt + PROMPT,
  }));

  pi.on("agent_end", async (e, ctx) => {
    setStatus(ctx);
    const msg = e.messages[e.messages.length - 1] as any;
    if (!msg?.content) return;
    const txt = (msg.content as any[])?.find((b: any) => b.type === "text")?.text;
    if (!txt) return;
    if (txt.includes("```") || txt.startsWith("#")) await sendMd(txt);
    else await send(txt);
  });
}
