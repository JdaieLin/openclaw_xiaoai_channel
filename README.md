# OpenClaw XiaoAi Channel Plugin

将小爱同学智能音箱（LX04 等）变成 OpenClaw 的对话通道。

已兼容 LX04 多系统版本混用：插件会根据设备系统版本自动选择 TTS 通道
（旧版优先 MiNA，新版优先 MiIOT，并自动回退）。

## 工作原理

```
用户 → 小爱同学(语音) → 小米云(对话记录) → 本插件(轮询)
  → OpenClaw(Agent) → 本插件(回复) → 小爱同学(TTS播报)
```

1. **轮询监听**：通过小米云服务 API 持续轮询小爱同学的对话记录
2. **拦截转发**：检测到新的用户提问后，停止小爱自带回复，将问题转发给 OpenClaw
3. **语音回复**：收到 OpenClaw 的回复后，通过小爱同学 TTS 播报

## 安装

```bash
openclaw plugins install /path/to/openclaw_xiaoai_channel/xiaoai-channel
```

## 配置

在 `~/.openclaw/openclaw.json` 中添加：

```jsonc
{
  "channels": {
    "xiaoai": {
      "enabled": true,
      "ttsEngine": "auto",             // 全局 TTS 策略: auto|miot|mina
      "accounts": [
        {
          "id": "lx04",
          "enabled": true,
          "did": "小爱触屏音箱",          // 米家App中的设备名称（不是型号！）
          "passToken": "V1:xxx...",      // 从浏览器获取的 passToken
          "ttsEngine": "auto",           // 可按设备覆盖: auto|miot|mina
          "startupVolume": 22,            // 启用该设备时自动设置音量(0-100)
          "pollInterval": 1,             // 轮询间隔（秒）
          "stopXiaoaiResponse": true,    // 是否打断小爱自带回复
          "keywordBlacklist": "播放音乐,放首歌,定闹钟,设闹钟,几点了,打开,关闭,音量"
        }
      ]
    }
  }
}
```

### 关键配置说明

#### `did` — 设备名称

⚠️ `did` 必须是**米家 App 中显示的设备名称**（如 `"小爱触屏音箱"`），而不是硬件型号（如 `"LX04"`）。

查看方法：打开米家 App → 找到你的小爱音箱 → 查看设备名称。

#### `passToken` — 认证令牌

本插件使用 `passToken` 进行认证，不需要配置小米账号和密码。

获取方法：

1. 在浏览器中打开 https://account.xiaomi.com 并登录
2. 打开开发者工具（F12）→ Application → Cookies
3. 找到 `passToken` 字段，复制其值
4. 将值填入配置的 `passToken` 字段

> 首次使用 passToken 登录后，凭据会缓存到 `~/.mi.json`，后续自动刷新，无需手动更新。

## 配置项参考

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | string | — | 账号标识 |
| `label` | string | — | 设备显示名称（如"客厅小爱"） |
| `enabled` | boolean | true | 是否启用 |
| `passToken` | string | — | 浏览器 passToken |
| `ttsEngine` | string | auto | TTS 通道策略：`auto`/`miot`/`mina` |
| `startupVolume` | number | — | 设备启用时自动设置音量（0-100） |
| `did` | string | — | 设备名称（米家中显示的名称） |
| `hardware` | string | LX04 | 设备型号（备用） |
| `miotDid` | string | — | MiIOT 设备 DID（通常自动获取） |
| `pollInterval` | number | 1 | 轮询间隔（秒） |
| `triggerPrefix` | string | — | 触发前缀（如"请问"） |
| `ttsChunkSize` | number | 200 | TTS 分段字符数 |
| `stopXiaoaiResponse` | boolean | true | 打断小爱自带回复 |
| `keywordBlacklist` | string | (见上) | 不转发的关键词（逗号分隔） |
| `enableTrace` | boolean | false | 启用 mi-service-lite 调试日志 |

## License

MIT
