# pi-wecom

> 企业微信群机器人(Webhook) DM bridge extension for pi

基于企业微信群机器人Webhook接口实现的pi扩展，支持向群聊推送消息。

## 功能特性

- ✅ 消息推送（群聊）
- ✅ 支持文本消息
- ✅ 支持Markdown格式
- ✅ 支持图片消息（base64）
- ✅ 支持图文链接卡片
- ✅ 支持加签密钥验证
- ✅ 消息分片（自动处理长消息）
- ✅ 配置文件持久化

## 与旧版区别

| 特性 | 旧版（企业内部应用） | 新版（群机器人） |
|------|---------------------|-----------------|
| 配置复杂度 | 高（CorpID+AgentID+Secret） | 低（仅需Webhook URL） |
| 消息方向 | 双向（收+发） | 单向（仅发送） |
| 接入难度 | 需要企业管理员 | 群主即可添加 |
| 使用场景 | 私聊/应用推送 | 群聊通知 |

## 安装

### 方式一：git安装（推荐）

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

### 方式二：本地开发

```bash
cd pi-wecom
pi install ./pi-wecom
```

### 方式三：单次运行

```bash
pi -e git:github.com/huang-x-h/pi-wecom
```

## 配置

### 创建企业微信群机器人

1. 打开企业微信电脑客户端
2. 进入任意群聊 → 点击群设置（右上角）
3. 找到「群机器人」→「添加机器人」
4. 为机器人设置名称，点击「添加」
5. 复制机器人的「Webhook URL」

> **注意**：如果有加签密钥，复制保存下来，后面配置需要用到。

### pi配置

启动pi后，运行：

```bash
/wecom-bot-setup
```

按提示输入：
1. Webhook URL（必需）
2. 加签密钥（可选，直接回车跳过）

配置会保存在 `~/.pi/agent/wecom-bot.json`

## 使用

### 基本命令

| 命令 | 说明 |
|------|------|
| `/wecom-bot-setup` | 配置群机器人 |
| `/wecom-bot-status` | 查看机器人状态 |
| `/wecom-bot-test` | 发送测试消息 |
| `/wecom-bot-enable` | 启用机器人 |
| `/wecom-bot-disable` | 禁用机器人 |

### LLM可调用工具

| 工具 | 说明 |
|------|------|
| `wecombot_attach` | 发送文件到群聊 |
| `wecom_send` | 发送消息到群聊 |

### 使用示例

```
# 让AI发送测试消息
请发送一条测试消息到群里

# 让AI生成分享内容并发送
帮我分析这段代码，然后发送到群里

# 发送文件
把上面的代码保存为文件并发送到群里
```

## 架构设计

```
┌─────────────────┐      HTTP/Webhook      ┌──────────────────┐
│                 │ ────────────────────►   │                  │
│   企业微信群      │    消息推送             │      pi          │
│   (群机器人)     │                        │  (Extension)     │
│                 │                        │                  │
└─────────────────┘                        └──────────────────┘
       │
       │ 群聊用户接收消息
       ▼
   企业微信用户
```

### 核心模块

- **BotAPI** - 群机器人API封装
- **MessageHandler** - 消息处理和分片
- **Signature** - 加签密钥签名生成
- **ConfigManager** - 配置管理

## API参考

### 消息类型

```typescript
// 发送文本
await sendText("Hello World");

// 发送Markdown
await sendMarkdown("# 标题\n**粗体**\n- 列表");

// 发送图片
await sendImage(base64Data, md5Hash);

// 发送图文卡片
await sendNews(
  "标题",
  "描述内容",
  "https://example.com",
  "https://example.com/image.png"
);

// 发送文本卡片
await sendTextCard(
  "事件提醒",
  "您有一个新任务需要处理",
  "查看详情",
  "https://example.com"
);
```

### 配置接口

```typescript
interface WeComBotConfig {
  webhookUrl?: string;  // Webhook URL（必需）
  secret?: string;       // 加签密钥（可选）
  enabled?: boolean;    // 是否启用
}
```

## 常见问题

### Q: 添加机器人时没有"群机器人"选项？
A: 确保是企业微信专业版或个人版，部分功能需要管理员开启。

### Q: 消息发送失败？
A: 检查：
1. Webhook URL 是否正确
2. 机器人是否被移出群聊
3. 群聊是否开启了"仅群主可发消息"

### Q: 如何@群成员？
A: 在消息中使用 `<@userid>` 格式，例如：
```
Hello <@user1> <@user2>，有新任务了
```

## 开发

### 项目结构

```
pi-wecom/
├── index.ts          # 主入口
├── package.json     # npm配置
├── README.md        # 文档
└── .gitignore
```

### 本地开发

```bash
# 克隆
git clone https://github.com/huang-x-h/pi-wecom.git
cd pi-wecom

# 安装依赖
npm install

# 链接到pi
pi install ./

# 测试运行
pi -e ./
```

## License

MIT
