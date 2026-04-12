/**
 * 企业微信 Token 快速测试
 * 使用方法：设置 CORP_ID 和 SECRET 后运行
 */

const https = require("node:https");

// ========== 请修改以下配置 ==========
// 优先使用环境变量，否则使用 test-wecom.json
const fs = require("node:fs");
const path = require("node:path");

let CORP_ID = process.env.WECOM_CORP_ID || "";
let SECRET = process.env.WECOM_CORP_SECRET || "";

// 如果环境变量未设置，尝试读取配置文件
if (!CORP_ID || !SECRET) {
  try {
    const configPath = path.join(__dirname, "test-wecom.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    CORP_ID = CORP_ID || config.corpId;
    SECRET = SECRET || config.corpSecret;
  } catch (e) {
    // 忽略
  }
}

if (!CORP_ID || !SECRET || CORP_ID === "wwxxxxxxxxxxxxxxxx") {
  console.log("❌ 请先配置凭证");
  console.log("   方式1: 设置环境变量 WECOM_CORP_ID 和 WECOM_CORP_SECRET");
  console.log("   方式2: 编辑 test-wecom.json 文件");
  process.exit(1);
}
// =================================

if (CORP_ID === "wwxxxxxxxxxxxxxxxx") {
  console.log("❌ 请先修改脚本中的 CORP_ID 和 SECRET");
  console.log("   打开文件: test-token.cjs");
  console.log("   修改第8-9行的配置");
  process.exit(1);
}

console.log("=".repeat(60));
console.log("🔍 企业微信 Token 测试");
console.log("=".repeat(60));
console.log();
console.log(`CorpID: ${CORP_ID}`);
console.log(`Secret: ${SECRET.substring(0, 5)}...${SECRET.slice(-5)}`);
console.log();

const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`;

console.log(`📡 请求URL: ${url.replace(SECRET, "***")}`);
console.log();

https.get(url, (res) => {
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    const result = JSON.parse(data);
    
    console.log("📥 响应数据:");
    console.log(JSON.stringify(result, null, 2));
    console.log();

    if (result.errcode === 0) {
      console.log("✅ ✅ ✅ 成功！");
      console.log(`   access_token: ${result.access_token}`);
      console.log(`   expires_in: ${result.expires_in} 秒`);
    } else {
      console.log(`❌ ❌ ❌ 失败！`);
      console.log(`   errcode: ${result.errcode}`);
      console.log(`   errmsg: ${result.errmsg}`);
      console.log();
      
      // 错误说明
      const errorInfo = {
        40013: "❓ CorpID 无效 - 请检查企业ID是否正确",
        40001: "❓ Secret 无效 - 请检查应用Secret是否正确",
        40032: "❓ Secret 类型错误 - 请确认是「自建应用」的Secret，不是「通讯录」Secret",
        41002: "❓ 参数为空 - corpId或corpSecret为空",
        42001: "❓ Token已过期 - 重新获取即可",
      };
      
      console.log("💡 可能原因:");
      console.log(errorInfo[result.errcode] || `未知错误码: ${result.errcode}`);
      console.log();
      console.log("📋 检查清单:");
      console.log("   1. CorpID 来自「我的企业」→「企业信息」");
      console.log("   2. Secret 来自「应用管理」→「自建应用」→ 你的应用");
      console.log("   3. 确保应用状态是「已启用」");
    }
  });
}).on("error", (e) => {
  console.log(`❌ 网络错误: ${e.message}`);
});
