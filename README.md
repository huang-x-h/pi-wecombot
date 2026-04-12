# wecombot

> 企业微信智能机器人 WebSocket 长连接扩展 for pi

使用官方 [aibot-node-sdk](https://developer.work.weixin.qq.com/document/path/101463) 实现。

## 安装

```bash
pi install git:github.com/huang-x-h/pi-wecom
```

## 配置

### 1. 获取凭证

在企业微信管理后台获取：
- **BotID**: `wwxxxxxxxxxxxxxxx` 格式
- **Secret**: 应用Secret

### 2. 在 pi 中配置

```
/wecombot-setup
# BotID: wwxxxxxxxxxxxxxxx
# Secret: xxxxxxxxxxxxxxx
# AgentID(可选): 
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
企业微信 ←── WebSocket ── aibot-sdk ── wecombot ── pi
              │                            │
              │                       AI处理
              ◄──────────────────────────回复
```

## 参考

- [企业微信智能机器人开发文档](https://developer.work.weixin.qq.com/document/path/101463)

## License

MIT
