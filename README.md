# OpenClaw XiaoAi Channel

将小爱同学 LX04 触屏音箱变成 OpenClaw 的对话通道。

用户对小爱同学说话 → 语音被捕获并发送给 OpenClaw → OpenClaw 回复通过小爱同学 TTS 播报。

## 工作原理

```
┌─────────────┐     语音输入     ┌──────────────────┐    HTTP API     ┌───────────┐
│  小爱同学    │ ──────────────→ │  XiaoAi Channel  │ ─────────────→ │  OpenClaw │
│  LX04 音箱  │ ←────────────── │  (本项目)         │ ←───────────── │  Server   │
└─────────────┘     TTS 播报     └──────────────────┘    AI 回复      └───────────┘
```

1. **轮询监听**：通过小米云服务 API 持续轮询小爱同学的对话记录
2. **拦截转发**：检测到新的用户提问后，停止小爱自带回复，将问题转发给 OpenClaw
3. **语音回复**：收到 OpenClaw 的回复后，通过小爱同学的 TTS 功能播报

## 功能特性

- 无需刷机，利用小米云服务 API 实现
- 支持对话上下文（多轮对话）
- 可配置触发前缀（如"请问"），避免所有对话都被拦截
- 关键词黑名单，保留小爱原有功能（播放音乐、设闹钟等）
- 长文本自动分段 TTS 播报
- 支持 Docker 部署
- 完善的错误处理和自动重试
- TypeScript 实现，与 OpenClaw (Node.js) 技术栈一致

## 环境要求

- Node.js >= 18
- 小米账号（已绑定小爱同学 LX04）
- OpenClaw 服务（提供 OpenAI 兼容的 Chat Completions API）

## 快速开始

### 1. 安装

```bash
# 克隆项目
git clone https://github.com/your-repo/openclaw_xiaoai_channel.git
cd openclaw_xiaoai_channel

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

### 2. 配置

#### 方式一：配置文件

```bash
# 复制示例配置
cp config.yaml.example config.yaml

# 编辑配置文件
vim config.yaml
```

填写以下必要信息：

```yaml
xiaomi:
  username: "your_xiaomi_account"   # 小米账号
  password: "your_xiaomi_password"  # 小米密码
  hardware: "LX04"                  # 设备型号

openclaw:
  api_url: "http://localhost:8000"  # OpenClaw API 地址
  api_key: "your_api_key"          # API Key
```

#### 方式二：环境变量

```bash
# 复制 .env 示例
cp .env.example .env

# 编辑 .env 文件
vim .env
```

```bash
MI_USER=your_xiaomi_account
MI_PASS=your_xiaomi_password
OPENCLAW_API_URL=http://localhost:8000
OPENCLAW_API_KEY=your_api_key
```

> 环境变量的优先级高于配置文件，两者可以混合使用。

### 3. 运行

```bash
# 运行（编译后）
npm start

# 或不编译直接运行（开发模式，使用 tsx）
npm run dev

# 指定配置文件
node dist/index.js -c /path/to/config.yaml

# 调试模式（显示详细日志）
node dist/index.js --debug
```

### 4. 使用

启动后，对小爱同学说话即可：

- **无触发前缀**：直接说 "小爱同学，今天天气怎么样" → OpenClaw 回答
- **有触发前缀**（如配置 `trigger_prefix: "请问"`）：说 "小爱同学，请问量子计算是什么" → OpenClaw 回答；说 "小爱同学，播放音乐" → 小爱原生处理

## Docker 部署

```bash
# 确保已配置 config.yaml 和 .env

# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

## 配置详解

### 小米账号 (`xiaomi`)

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `username` | 小米账号（手机号或邮箱） | 必填 |
| `password` | 小米账号密码 | 必填 |
| `hardware` | 设备硬件型号 | `LX04` |
| `did` | 设备 DID，多设备时指定 | 自动检测 |

### OpenClaw (`openclaw`)

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `api_url` | OpenClaw API 地址 | `http://localhost:8000` |
| `api_key` | API 认证密钥 | 空 |
| `model` | 模型名称 | `default` |
| `system_prompt` | 系统提示词 | 见配置文件 |

### Channel (`channel`)

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `poll_interval` | 轮询间隔（秒） | `1.0` |
| `trigger_prefix` | 触发前缀，空则转发所有 | 空 |
| `max_history` | 最大对话历史轮数 | `20` |
| `tts_chunk_size` | TTS 分段字符数 | `200` |
| `stop_xiaoai_response` | 是否停止小爱自带回复 | `true` |
| `keyword_blacklist` | 不转发的关键词（逗号分隔） | 见配置文件 |

### 支持的设备型号

| 型号 | 设备名称 |
|------|----------|
| `LX04` | 小爱触屏音箱 |
| `LX06` | 小爱音箱 Pro |
| `L05B` | 小米小爱音箱 Play |
| `L05C` | 小米小爱音箱 Play 增强版 |
| `L09A` | 小米小爱音箱 |
| `L09B` | 小米小爱音箱 Play (2019) |
| `S12A` | 小米智能音箱 |
| `LX01` | 小爱音箱 mini |
| `L06A` | 小爱音箱 |
| `L17A` | Xiaomi Sound Pro |
| `X08E` | 小爱触屏音箱 Pro 8 |

> 如不确定型号，启动时使用 `--debug` 参数查看设备列表。

## OpenClaw API 兼容性

本项目使用 OpenAI 兼容的 Chat Completions API 格式：

```
POST {api_url}/v1/chat/completions
```

请求体：
```json
{
  "model": "default",
  "messages": [
    {"role": "system", "content": "系统提示词"},
    {"role": "user", "content": "用户消息"}
  ],
  "stream": false
}
```

响应体：
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "AI 回复内容"
      }
    }
  ]
}
```

如果你的 OpenClaw 使用不同的 API 格式，请修改 `src/openclaw-client.ts` 中的请求/响应处理逻辑。

## 项目结构

```
openclaw_xiaoai_channel/
├── README.md                       # 本文档
├── package.json                    # 项目配置 & 依赖
├── tsconfig.json                   # TypeScript 编译配置
├── config.yaml.example             # 配置文件示例
├── .env.example                    # 环境变量示例
├── .gitignore
├── Dockerfile                      # Docker 多阶段构建
├── docker-compose.yml              # Docker Compose 部署
└── src/                            # TypeScript 源代码
    ├── index.ts                    # CLI 入口点
    ├── config.ts                   # 配置管理
    ├── logger.ts                   # 日志工具
    ├── mi-service.ts               # 小爱同学服务（基于 mi-service-lite）
    ├── openclaw-client.ts          # OpenClaw API 客户端
    └── channel.ts                  # Channel 桥接逻辑
```

## 常见问题

### Q: 登录失败怎么办？

1. 确认小米账号和密码正确
2. 如果开启了二步验证，需要使用应用专用密码
3. 首次在新设备/IP 登录可能需要在小米手机上确认安全验证

### Q: 找不到设备？

1. 确认小爱音箱已在米家 App 中绑定
2. 使用 `--debug` 模式查看所有可用设备列表
3. 如果有多台小爱设备，通过 `did` 参数指定目标设备

### Q: 小爱同时回复了自己的答案和 OpenClaw 的答案？

将 `stop_xiaoai_response` 设为 `true`（默认已开启），程序会在转发前停止小爱的回复。如果仍有问题，可以适当增大 `poll_interval` 让检测更及时。

### Q: 如何保留小爱的原有功能？

1. 设置 `trigger_prefix`，如 `"请问"`，只有以该前缀开头的对话才会转发
2. 在 `keyword_blacklist` 中添加不需要转发的关键词

### Q: 如何查看设备的 DID？

使用 `--debug` 模式运行，日志中会显示已匹配设备的 DeviceID 和 MiotDID。

## 注意事项

- 本项目通过小米云服务 API 实现，依赖网络连接
- 轮询方式存在一定延迟（取决于 `poll_interval` 设置）
- 请勿将轮询间隔设得过小（< 0.5s），以免触发频率限制
- 小米账号密码仅在本地使用，不会发送到第三方服务器
- 建议在内网环境运行，确保与 OpenClaw 服务的通信安全
- `mi-service-lite` 会在本地缓存 token（`.mi.json`），避免频繁登录

## License

MIT
