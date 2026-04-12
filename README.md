# wecombot

> 企业微信群机器人长连接扩展 for pi

通过 WebSocket 长连接与企业微信机器人通信。

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 配置

### 1. 添加群机器人

```
企业微信电脑客户端 → 打开任意群聊 → 群设置 → 群机器人 → 添加机器人
```

### 2. 获取 Key

复制机器人的 Key（Webhook URL 中的 key 参数）

### 3. 在 pi 中配置

```
/wecombot-setup
# 输入机器人 Key
# 加签密钥（可选）
```

## 命令

| 命令 | 说明 |
|------|------|
| `/wecombot-setup` | 配置机器人 |
| `/wecombot-status` | 查看状态 |
| `/wecombot-test` | 发送测试 |

## 工具

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发送消息 |
| `wecombot_attach` | 发送文件 |

## 工作原理

```
企业微信群 ←──WebSocket── wecombot ←── aibot-sdk
     │                              │
     │                         pi AI处理
     ◄──────────────────────────回复
```

1. 用 Key 建立 WebSocket 长连接
2. 群消息自动转发给 pi
3. 回复自动发送到群聊

## License

MIT
