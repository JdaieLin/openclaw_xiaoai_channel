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

## 调试工具 (tools.js)

插件附带一个独立的调试工具，用于在不启动 OpenClaw 的情况下直接测试小爱设备连接、TTS 播放、音量控制等功能。

### 前置条件

需要先通过 OpenClaw 配置完成一次小米账号登录（凭据缓存在 `~/.mi.json`），之后工具使用 `passToken` 认证即可。

### 命令一览

```bash
# 进入插件目录
cd xiaoai-channel

# 列出所有可用设备（查看设备名称、型号、miotDID 等信息）
node tools.js list --pass-token "V1:xxx..."

# 播放 TTS 文本
node tools.js tts "你好世界"
node tools.js tts "你好世界" --did "小爱触屏音箱"

# 查看/设置音量 (0-100)
node tools.js volume                        # 查看当前音量
node tools.js volume 30                     # 设置音量为 30
node tools.js volume 20 --did "卧室的小爱"   # 对指定设备设置音量

# 查看设备播放状态
node tools.js status

# 暂停当前播放
node tools.js pause

# 测试打断小爱自带回复（先播放长文本，3秒后尝试打断）
node tools.js test-interrupt
```

### 参数说明

| 参数 | 说明 |
|------|------|
| `--pass-token <token>` | 小米 passToken（也可通过环境变量 `MI_PASS_TOKEN` 设置） |
| `--did <设备名>` | 指定设备名称（也可通过环境变量 `MI_DID` 设置） |
| `--tts-engine auto\|miot\|mina` | 指定 TTS 引擎（默认 auto） |
| `--trace` | 启用 mi-service-lite 调试日志 |

### 命令别名

| 命令 | 别名 |
|------|------|
| `list` | `ls`, `devices` |
| `tts` | `say`, `speak` |
| `volume` | `vol` |
| `status` | `info` |
| `pause` | `stop` |
| `test-interrupt` | `interrupt` |

### 使用示例

```bash
# 通过环境变量设置 passToken，避免每次输入
export MI_PASS_TOKEN="V1:xxx..."

# 列出设备，找到 did 和 miotDID
node tools.js list

# 对指定设备测试 TTS
node tools.js tts "测试语音播报" --did "小爱触屏音箱"

# 调低音量后再测试
node tools.js volume 15 --did "小爱触屏音箱"
node tools.js tts "音量已调低"

# 测试打断功能是否对你的设备有效
node tools.js test-interrupt --did "小爱触屏音箱"
```

## License

MIT
