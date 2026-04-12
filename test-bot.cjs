/**
 * 企业微信群机器人 API 测试
 * 
 * 使用方法：
 * 1. 编辑 test-wecom.json 填入 Webhook URL
 * 2. 运行: node test-bot.cjs
 */

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

console.log("=".repeat(60));
console.log("🔧 企业微信群机器人 API 测试");
console.log("=".repeat(60));
console.log();

// 读取配置
const configPath = path.join(__dirname, "test-wecom.json");
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (e) {
  console.log("❌ 无法读取配置文件 test-wecom.json");
  process.exit(1);
}

const { webhookUrl, secret } = config;

if (!webhookUrl || webhookUrl.includes("xxxxxxxx")) {
  console.log("❌ 请先修改 test-wecom.json 中的 Webhook URL");
  console.log();
  console.log("📋 获取 Webhook URL 步骤:");
  console.log("   1. 打开企业微信电脑客户端");
  console.log("   2. 进入任意群聊 → 群设置 → 群机器人");
  console.log("   3. 添加机器人 → 复制 Webhook URL");
  process.exit(1);
}

console.log(`📄 Webhook URL: ${webhookUrl}`);
console.log(`🔐 加签密钥: ${secret ? "已配置" : "未配置"}`);
console.log();

// 构建请求URL
let url = webhookUrl;
if (secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = crypto.createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  url = `${webhookUrl}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  console.log(`🔏 签名: timestamp=${timestamp}, sign=${sign.substring(0, 20)}...`);
}

// 准备消息
const messages = [
  {
    name: "文本消息",
    data: {
      msgtype: "text",
      text: {
        content: "🧪 来自 pi-wecom 的测试消息\n\n✅ 企业微信群机器人连接成功！"
      }
    }
  },
  {
    name: "Markdown消息",
    data: {
      msgtype: "markdown",
      markdown: {
        content: "# 🎉 连接成功\n\n- ✅ Webhook URL 正确\n- ✅ 消息发送正常\n- ✅ 机器人已就绪\n\n> 使用 `/wecom-bot-setup` 在 pi 中配置此机器人"
      }
    }
  },
  {
    name: "图文卡片",
    data: {
      msgtype: "news",
      news: {
        articles: [
          {
            title: "pi-wecom",
            description: "企业微信群机器人扩展 for pi",
            url: "https://github.com/huang-x-h/pi-wecom",
            picurl: ""
          }
        ]
      }
    }
  }
];

// 发送消息
async function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`解析响应失败: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(JSON.stringify(message));
    req.end();
  });
}

// 执行测试
(async () => {
  for (const msg of messages) {
    console.log(`📤 发送: ${msg.name}...`);
    try {
      const result = await sendMessage(msg.data);
      if (result.errcode === 0) {
        console.log(`   ✅ 成功！`);
      } else {
        console.log(`   ❌ 失败: [${result.errcode}] ${result.errmsg}`);
      }
    } catch (e) {
      console.log(`   ❌ 错误: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500)); // 避免频率限制
  }

  console.log();
  console.log("=".repeat(60));
  console.log("📊 测试完成");
  console.log("=".repeat(60));
  console.log();
  console.log("💡 下一步:");
  console.log("   1. 检查群聊是否收到测试消息");
  console.log("   2. 在 pi 中运行 /wecom-bot-setup");
  console.log("   3. 开始使用！");
})();
