# pi-wecom

> 企业微信群机器人长连接(WebSocket) bridge extension for pi

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 配置

### 1. 添加群机器人

企业微信群 → 群设置 → 群机器人 → 添加机器人 → 复制 Webhook URL

### 2. 在 pi 中配置

```bash
/wecom-bot-setup
```

## 命令

| 命令 | 说明 |
|------|------|
| `/wecom-bot-setup` | 配置机器人 |
| `/wecom-bot-status` | 查看状态 |
| `/wecom-bot-test` | 发送测试消息 |

## 工具

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发送消息 |
| `wecombot_attach` | 发送文件 |

## 长连接流程

```
1. 解析 Webhook URL 获取 key
2. 建立 WebSocket: wss://qyapi.weixin.qq.com/wvp/session/longconnection?key=xxx
3. 自动重连保持连接
```

## License

MIT
