# pi-wecombot

> 企业微信智能机器人 WebSocket 长连接扩展 for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) 实现。

## 功能特性

- 🔗 **WebSocket 长连接** - 自动重连，断线无忧
- 🤖 **多机器人支持** - 支持配置多个机器人，快速切换
- 👥 **多人会话管理** - 按 req_id 区分不同用户
- 🔄 **消息自动转发** - 收到 @机器人 的消息自动处理
- 📤 **回复自动发送** - AI 回复自动发送到企业微信

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecombot
```

## 快速开始

### 1. 添加机器人

```
/wecombot-add
# 机器人名称(可选): 我的助手
# BotID: wwxxxxxxxxxxxxx
# Secret: xxxxxxxxxxxxxxx
```

### 2. 查看机器人列表

```
/wecombot-list
```

### 3. 切换机器人

```
/wecombot-use
# 选择机器人: wwxxxxxxxxxxxxx
```

## 命令

| 命令 | 说明 |
|------|------|
| `/wecombot-add` | 添加新机器人 |
| `/wecombot-list` | 列出所有机器人 |
| `/wecombot-use` | 切换机器人 |
| `/wecombot-remove` | 删除机器人 |
| `/wecombot-status` | 查看状态 |
| `/wecombot-enable` | 开启机器人 |
| `/wecombot-disable` | 关闭机器人 |
| `/wecombot-test` | 发送测试 |

## 工具

| 工具 | 说明 |
|------|------|
| `wecombot-send` | 发送消息 |
| `wecombot-attach` | 发送文件 |

## 多机器人管理

```
# 添加第一个机器人
/wecombot-add
  名称: 助手A
  BotID: ww111...
  Secret: xxx

# 添加第二个机器人
/wecombot-add
  名称: 助手B
  BotID: ww222...
  Secret: yyy

# 查看列表
/wecombot-list
▶ 助手A (ww111...)
○ 助手B (ww222...)

# 切换
/wecombot-use
  选择: ww222...
```

## 会话管理

```
用户A @机器人 → req_id:A → 独立处理
用户B @机器人 → req_id:B → 独立处理
```

## 工作原理

```
┌──────────────┐    WebSocket     ┌──────────────┐
│              │ ◄────────────►  │              │
│  企业微信     │   aibot-sdk    │    pi        │
│  智能机器人   │                │              │
│              │ ─────────────►  │   AI处理     │
└──────────────┘    消息收发     └──────────────┘
```

## 参考

- [企业微信智能机器人开发文档](https://developer.work.weixin.qq.com/document/path/101463)
- [aibot-node-sdk](https://www.npmjs.com/package/aibot-node-sdk)

## License

MIT
