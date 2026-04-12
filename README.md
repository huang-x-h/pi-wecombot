# pi-wecom

> 企业微信群机器人长连接扩展 for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463)。

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 配置

```
企业微信群 → 群设置 → 群机器人 → 添加机器人
/wecom-bot-setup
```

## 使用

| 命令 | 说明 |
|------|------|
| `/wecom-bot-setup` | 配置 |
| `/wecom-bot-status` | 状态 |
| `/wecom-bot-test` | 测试 |

| 工具 | 说明 |
|------|------|
| `wecom_send` | 发消息 |
| `wecombot_attach` | 发文件 |

## 原理

```
WebSocket 长连接 ← aibot-node-sdk ← Webhook URL提取key
```

## License

MIT
