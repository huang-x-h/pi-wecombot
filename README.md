# pi-wecom

> 企业微信群机器人长连接扩展 for pi

通过 WebSocket 长连接与企业微信机器人通信，支持消息接收和发送。

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 快速开始

### 1. 添加群机器人

```
企业微信电脑客户端
  └── 打开任意群聊
      └── 群设置（右上角）
          └── 群机器人
              └── 添加机器人
                  └── 复制 Webhook URL
```

### 2. 在 pi 中配置

```
/pi
/wecom-setup
# 输入 Webhook URL
# 加签密钥（可选）
```

### 3. 使用

在群聊中 @机器人 发送消息即可自动处理。

## 命令

| 命令 | 说明 |
|------|------|
| `/wecom-setup` | 配置机器人 |
| `/wecom-status` | 查看连接状态 |
| `/wecom-test` | 发送测试消息 |

## 工具

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发送消息到群聊 |
| `wecombot_attach` | 发送文件到群聊 |

### 使用示例

```
# 让AI回复消息到群聊
@机器人 分析这段代码有什么问题

# 发送文件
帮我把上面的代码保存并发送到群聊
```

## 工作原理

```
┌──────────────┐    WebSocket     ┌──────────────┐
│              │ ◄────────────►  │              │
│  企业微信     │   aibot-sdk    │     pi       │
│  群机器人     │                │              │
│              │ ─────────────► │   AI处理     │
└──────────────┘    消息发送    └──────────────┘
```

1. 从 Webhook URL 提取 key
2. 通过 `aibot-node-sdk` 建立 WebSocket 长连接
3. 群聊消息自动转发给 pi 处理
4. pi 回复自动发送到群聊

## 依赖

- [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) - 官方 SDK

## License

MIT
