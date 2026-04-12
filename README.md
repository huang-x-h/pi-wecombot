# pi-wecom

> 企业微信(WeCom) DM bridge extension for pi

基于 [pi-telegram](https://github.com/badlogic/pi-telegram) 架构设计的企业微信集成扩展。

## 功能特性

- ✅ 消息双向转发（企业微信 ↔ pi）
- ✅ 支持文本、Markdown、图片、文件消息
- ✅ 自动配对用户
- ✅ 消息队列与任务中止
- ✅ 使用统计显示
- ✅ 文件附件发送
- ✅ 系统提示词注入

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

### 企业微信后台配置

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)
2. 进入「应用管理」→ 创建自建应用
3. 获取以下信息：
   - `AgentId`（应用ID）
   - `Secret`（应用密钥）
4. 获取企业信息：
   - `CorpId`（企业ID）- 在「我的企业」页面获取
5. 配置应用「接收消息」：
   - 启用「接收消息」
   - 设置「Token」和「EncodingAESKey」
6. 在应用的「开发者接口」中设置「企业可信IP」

### pi配置

启动pi后，运行：

```bash
/wecom-setup
```

按提示输入：
1. 企业ID (CorpID)
2. 应用AgentID
3. 应用Secret

配置会保存在 `~/.pi/agent/wecom.json`

## 使用

### 基本命令

| 命令 | 说明 |
|------|------|
| `/wecom-setup` | 配置企业微信凭证 |
| `/wecom-status` | 查看桥接状态 |
| `/wecom-send <用户ID> <消息>` | 向指定用户发送消息 |
| `/wecom-broadcast <消息>` | 通过群机器人广播（需配置webhook） |

### 交互方式

1. 在企业微信中向应用发送消息
2. 消息会被转发到pi，添加 `[wecom]` 前缀
3. pi的回复会自动发送回企业微信

### 内置命令

在企业微信中发送：

| 命令 | 说明 |
|------|------|
| `/help` 或 `/start` | 显示帮助 |
| `/status` | 显示使用统计 |
| `stop` 或 `/stop` | 中止当前任务 |

### 文件发送

当企业微信用户请求文件或需要发送附件时，LLM会自动调用 `telegram_attach` 工具：

| 工具名称 | 说明 |
|---------|------|
| `telegram_attach` | 将本地文件加入队列，在回复时通过企业微信发送 |

#### 使用示例

用户可以请求：
- "把上面的代码保存为文件并发送给我"
- "生成分享链接并发送"
- "导出日志文件"

LLM会：
1. 生成所需文件
2. 调用 `telegram_attach` 工具将文件加入发送队列
3. 扩展在回复时自动将文件发送到企业微信

#### 支持的文件类型

| 类型 | 说明 | 最大限制 |
|------|------|---------|
| 图片 (jpg/png/gif/webp) | 作为图片发送 | 10MB |
| 文档 (pdf/doc/xlsx) | 作为文件发送 | 20MB |
| 视频 (mp4) | 作为文件发送 | 10MB |
| 其他 | 作为文件发送 | 20MB |

> **注意**：扩展自动处理文件格式识别，无需手动指定。

## 架构设计

```
┌─────────────────┐      HTTP/Webhook      ┌──────────────────┐
│                 │ ◄────────────────────► │                  │
│   企业微信       │    消息回调/推送         │      pi          │
│  (自建应用)     │                        │  (Extension)    │
│                 │ ◄────────────────────► │                  │
└─────────────────┘                        └──────────────────┘
       │                                             │
       │                                             │
       ▼                                             ▼
  企业微信用户                                    AI处理
  (员工/客户)                                   (LLM + Tools)
```

### 核心模块

- **WeComAPI** - 企业微信API封装（access_token管理、重试机制）
- **TurnManager** - 消息任务管理（队列、并发、取消）
- **ConfigManager** - 配置管理（持久化、配对）
- **EventHandlers** - pi事件处理（session、agent、message生命周期）

## 开发

### 项目结构

```
pi-wecom/
├── index.ts          # 主入口
├── package.json      # npm配置
├── README.md         # 文档
└── tsconfig.json     # TypeScript配置
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

### 类型检查

```bash
npx tsc --noEmit
```

## API参考

### 配置接口

```typescript
interface WeComConfig {
  corpId?: string;        // 企业ID
  agentId?: string;       // 应用AgentID
  corpSecret?: string;    // 应用Secret
  webhookUrl?: string;    // 群机器人Webhook（可选）
  allowedUserId?: string; // 允许的用户ID（配对后）
  token?: string;         // 回调Token
  aesKey?: string;        // 回调AES密钥
}
```

### 可用方法

```typescript
// 发送文本消息
await sendTextMessage(userId, content);

// 发送Markdown
await sendMarkdownMessage(userId, markdown);

// 发送图文消息
await sendNewsMessage(userId, [{
  title: "标题",
  description: "描述",
  url: "https://...",
  picurl: "https://..."
}]);

// 处理收到的消息
await handleWeComMessage(userId, content, ctx);
```

## 注意事项

1. **安全**：扩展只在配对的用户和企业微信应用之间转发消息
2. **限流**：企业微信API有调用频率限制，扩展内置重试机制
3. **Token**：access_token会自动刷新，扩展处理过期情况
4. **附件**：单个附件建议不超过20MB，企业微信有限制

## License

MIT
