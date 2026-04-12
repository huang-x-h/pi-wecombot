# pi-wecom

> 企业微信群机器人长连接 bridge extension for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) 实现。

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 配置

### 1. 添加群机器人

```
企业微信电脑客户端 → 群聊 → 群设置 → 群机器人 → 添加机器人
```

### 2. 在 pi 中配置

```bash
/wecom-bot-setup
```

## 使用

### 命令

| 命令 | 说明 |
|------|------|
| `/wecom-bot-setup` | 配置机器人 |
| `/wecom-bot-status` | 查看状态 |
| `/wecom-bot-test` | 发送测试消息 |

### 工具

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发送消息 |
| `wecombot_attach` | 发送文件 |

## 工作流程

```
1. 从 Webhook URL 提取 key
2. 使用 aibot-node-sdk 建立 WebSocket 长连接
3. 接收群聊消息 → 转发给 pi 处理
4. pi 回复 → 通过机器人发送回群聊
```

## License

MIT
