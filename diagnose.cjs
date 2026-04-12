/**
 * 企业微信配置诊断工具
 * 模拟 /wecom-setup 的配置验证流程
 */

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

console.log("=".repeat(60));
console.log("🔧 企业微信配置诊断");
console.log("=".repeat(60));
console.log();

// 读取配置文件
const configPath = path.join(__dirname, "test-wecom.json");
let config;

try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  console.log("📄 已读取配置文件 test-wecom.json:");
  console.log(`   corpId: ${config.corpId}`);
  console.log(`   agentId: ${config.agentId}`);
  console.log(`   corpSecret: ${config.corpSecret ? config.corpSecret.substring(0, 5) + "..." : "(空)"}`);
  console.log();
} catch (e) {
  console.log("❌ 无法读取配置文件 test-wecom.json");
  console.log();
  config = {};
}

// 获取配置
const corpId = config.corpId;
const agentId = config.agentId;
const corpSecret = config.corpSecret;

// ========== 诊断步骤 ==========

console.log("=".repeat(60));
console.log("📋 诊断步骤");
console.log("=".repeat(60));
console.log();

// 步骤1: 检查配置是否完整
console.log("📍 步骤1: 检查配置完整性");
if (!corpId) {
  console.log("   ❌ corpId 为空");
} else if (!corpId.startsWith("ww")) {
  console.log(`   ⚠️  corpId 格式异常（应以 ww 开头）: ${corpId}`);
} else {
  console.log(`   ✅ corpId: ${corpId}`);
}

if (!agentId) {
  console.log("   ⚠️  agentId 为空（可选）");
} else {
  console.log(`   ✅ agentId: ${agentId}`);
}

if (!corpSecret) {
  console.log("   ❌ corpSecret 为空");
} else {
  console.log(`   ✅ corpSecret: ${corpSecret.substring(0, 5)}...`);
}
console.log();

// 步骤2: 测试 Token 获取
console.log("📍 步骤2: 测试 Token 获取");

if (!corpId || !corpSecret) {
  console.log("   ⏭️  跳过：配置不完整");
} else {
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
  console.log(`   📡 请求: GET /cgi-bin/gettoken`);
  console.log(`   🔗 URL: ${url.replace(corpSecret, "***")}`);
  console.log();

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      const result = JSON.parse(data);
      
      console.log("   📥 响应:");
      console.log(`      errcode: ${result.errcode}`);
      console.log(`      errmsg: ${result.errmsg}`);
      console.log();

      if (result.errcode === 0) {
        console.log("   ✅ ✅ ✅ Token 获取成功！");
        console.log(`      access_token: ${result.access_token.substring(0, 20)}...`);
        console.log(`      expires_in: ${result.expires_in} 秒`);
        console.log();
        console.log("=".repeat(60));
        console.log("🎉 配置诊断通过！");
        console.log("=".repeat(60));
        console.log();
        console.log("💡 下一步:");
        console.log("   1. 将配置复制到 pi 配置目录:");
        console.log(`      cp ${configPath} ~/.pi/agent/wecom.json`);
        console.log("   2. 在 pi 中运行 /wecom-setup 重新配置");
      } else {
        console.log("   ❌ ❌ ❌ Token 获取失败！");
        console.log();
        
        const errorDetails = {
          40013: "【CorpID无效】请检查 corpId 是否正确",
          40001: "【Secret无效】请检查 corpSecret 是否正确",
          40032: "【Secret类型错误】请确认使用的是「自建应用」的 Secret，而非「通讯录」Secret",
          41002: "【参数为空】corpId 或 corpSecret 为空",
          42001: "【Token过期】请重新获取",
        };
        
        console.log("   💡 错误说明:");
        console.log(`      ${errorDetails[result.errcode] || `未知错误: ${result.errcode}`}`);
        console.log();
        console.log("=".repeat(60));
        console.log("⚠️  配置诊断未通过");
        console.log("=".repeat(60));
        console.log();
        console.log("📋 请检查:");
        console.log("   1. CorpID 来自: 企业微信管理后台 → 我的企业 → 企业信息");
        console.log("   2. Secret 来自: 应用管理 → 自建应用 → 你的应用 → Secret");
        console.log("   3. 确保应用状态为「已启用」");
      }
    });
  }).on("error", (e) => {
    console.log(`   ❌ 网络错误: ${e.message}`);
  });
}
