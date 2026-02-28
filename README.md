# OpenClaw XiaoAi Channel Plugin

将小爱同学智能音箱（LX04 等）变成 OpenClaw 的对话通道。

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
      "accounts": [
        {
          "id": "lx04",
          "enabled": true,
          "miUser": "你的小米账号",       // 手机号或邮箱
          "miPass": "你的小米密码",       // 密码
          "did": "小爱触屏音箱",          // 米家App中的设备名称（不是型号！）
          "passToken": "V1:xxx...",      // 从浏览器获取的 passToken（推荐）
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

#### `passToken` — 认证令牌（推荐）

由于小米账号登录会触发安全验证（securityStatus: 16），纯密码登录通常无法直接使用。推荐使用 `passToken` 方式认证。

获取方法：

1. 在浏览器中打开 https://account.xiaomi.com 并登录
2. 打开开发者工具（F12）→ Application → Cookies
3. 找到 `passToken` 字段，复制其值
4. 将值填入配置的 `passToken` 字段

> passToken 会在每次登录时自动刷新并保存到 `.mi.json`，首次配置后无需再手动更新。

## 已知问题

### mi-service-lite userId 补丁

本插件依赖一个对 `mi-service-lite` 的补丁：登录成功后必须将 `account.userId` 从手机号更新为小米数字 ID。

**原因**：小米 API 的 serviceToken 绑定于数字 userId（如 `1048096023`），但库不会自动更新 `account.userId`，导致 API Cookie 中的手机号与 serviceToken 不匹配，返回 401。

**补丁**：在 `node_modules/mi-service-lite/dist/index.js` 的 `getAccount()` 函数中，`account = { ...account, pass, serviceToken }` 之后添加：

```javascript
if (pass.userId) {
    account.userId = pass.userId.toString();
}
```

⚠️ `npm install` 会覆盖此补丁，需要重新应用。

## 配置项参考

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | string | — | 账号标识 |
| `enabled` | boolean | true | 是否启用 |
| `miUser` | string | — | 小米账号（手机号/邮箱） |
| `miPass` | string | — | 小米密码 |
| `passToken` | string | — | 浏览器 passToken（推荐） |
| `did` | string | — | 设备名称（米家中显示的名称） |
| `hardware` | string | LX04 | 设备型号（备用） |
| `pollInterval` | number | 1 | 轮询间隔（秒） |
| `triggerPrefix` | string | — | 触发前缀（如"请问"） |
| `ttsChunkSize` | number | 200 | TTS 分段字符数 |
| `stopXiaoaiResponse` | boolean | true | 打断小爱自带回复 |
| `keywordBlacklist` | string | (见上) | 不转发的关键词（逗号分隔） |
| `enableTrace` | boolean | false | 启用 mi-service-lite 调试日志 |

## License

MIT
