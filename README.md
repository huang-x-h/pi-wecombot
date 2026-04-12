# pi-wecombot

> 企业微信智能机器人 WebSocket 长连接扩展 for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) 实现。

## 功能特性

- 🔗 **WebSocket 长连接** - 自动重连，断线无忧
- 👥 **多人会话管理** - 按 req_id 区分不同用户
- 🔄 **消息自动转发** - 收到 @机器人 的消息自动处理
- 📤 **回复自动发送** - AI 回复自动发送到企业微信
- 📁 **文件发送** - 支持发送图片和文件

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecombot
```

## 配置

### 1. 创建智能机器人

在企业微信管理后台创建应用，获取：
- **AgentId** - 应用ID
- **Secret** - 应用Secret

### 2. 在 pi 中配置

```
/wecombot-setup
# BotID: wwxxxxxxxxxxxxx
# Secret: xxxxxxxxxxxxxxx
# AgentID(可选):
```

## 命令

| 命令 | 说明 |
|------|------|
| `/wecombot-setup` | 配置机器人凭证 |
| `/wecombot-status` | 查看连接状态 |
| `/wecombot-enable` | 开启机器人 |
| `/wecombot-disable` | 关闭机器人 |
| `/wecombot-sessions` | 查看活跃会话 |
| `/wecombot-test` | 发送测试消息 |

## 工具

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发送消息到企业微信 |
| `wecombot_attach` | 发送文件到企业微信 |

## 会话管理

```
用户A @机器人 → req_id:A → 独立处理
用户B @机器人 → req_id:B → 独立处理
用户C @机器人 → req_id:C → 独立处理
```

- 每个请求独立处理，不会串消息
- 会话 10 分钟无活动自动清理
- 状态栏显示活跃会话数

## 工作原理

```
┌──────────────┐    WebSocket     ┌──────────────┐
│              │ ◄────────────►  │              │
│  企业微信     │   aibot-sdk    │    pi        │
│  智能机器人   │                │              │
│              │ ─────────────►  │   AI处理     │
└──────────────┘    消息收发     └──────────────┘
```

1. 使用 BotID + Secret 建立 WebSocket 长连接
2. 收到 @机器人 的消息自动转发给 pi 处理
3. pi 回复自动发送到对应的用户会话

## 参考

- [企业微信智能机器人开发文档](https://developer.work.weixin.qq.com/document/path/101463)
- [aibot-node-sdk](https://www.npmjs.com/package/aibot-node-sdk)

## License

MIT
