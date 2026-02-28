/**
 * 配置管理模块
 *
 * 支持从 YAML 配置文件和环境变量加载配置，环境变量优先。
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ─── 配置类型定义 ────────────────────────────────────────────

export interface XiaomiConfig {
  /** 小米账号（手机号或邮箱） */
  username: string;
  /** 小米账号密码 */
  password: string;
  /** 设备硬件型号 */
  hardware: string;
  /** 设备 DID，留空自动检测 */
  did: string;
}

export interface OpenClawConfig {
  /** OpenClaw API 地址 */
  apiUrl: string;
  /** OpenClaw API Key */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** 系统提示词 */
  systemPrompt: string;
}

export interface ChannelConfig {
  /** 轮询间隔（秒） */
  pollInterval: number;
  /** 触发前缀，空表示所有对话都转发 */
  triggerPrefix: string;
  /** 最大对话历史轮数 */
  maxHistory: number;
  /** TTS 分段字符数 */
  ttsChunkSize: number;
  /** 是否停止小爱自带回复 */
  stopXiaoaiResponse: boolean;
  /** 关键词黑名单（逗号分隔） */
  keywordBlacklist: string;
}

export interface AppConfig {
  xiaomi: XiaomiConfig;
  openclaw: OpenClawConfig;
  channel: ChannelConfig;
}

// ─── 默认配置 ────────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  xiaomi: {
    username: "",
    password: "",
    hardware: "LX04",
    did: "",
  },
  openclaw: {
    apiUrl: "http://localhost:8000",
    apiKey: "",
    model: "default",
    systemPrompt:
      "你是一个智能助手，正在通过小爱同学音箱与用户对话。请尽量简洁地回答用户的问题。",
  },
  channel: {
    pollInterval: 1.0,
    triggerPrefix: "",
    maxHistory: 20,
    ttsChunkSize: 200,
    stopXiaoaiResponse: true,
    keywordBlacklist: "播放音乐,放首歌,定闹钟,设闹钟,几点了,打开,关闭,音量",
  },
};

// ─── 配置加载 ────────────────────────────────────────────────

/**
 * 从 YAML 文件加载原始配置（key 可能是 snake_case）。
 */
function loadYamlConfig(configPath: string): Record<string, any> {
  if (!existsSync(configPath)) {
    return {};
  }
  const content = readFileSync(configPath, "utf-8");
  return parseYaml(content) ?? {};
}

/**
 * 从配置文件和环境变量加载完整配置。
 * 环境变量优先级高于配置文件。
 */
export function loadConfig(configPath?: string): AppConfig {
  // 从 YAML 加载
  const raw = configPath ? loadYamlConfig(configPath) : {};
  const rawXiaomi = raw.xiaomi ?? {};
  const rawOpenclaw = raw.openclaw ?? {};
  const rawChannel = raw.channel ?? {};

  const config: AppConfig = {
    xiaomi: {
      username:
        process.env.MI_USER ?? rawXiaomi.username ?? DEFAULT_CONFIG.xiaomi.username,
      password:
        process.env.MI_PASS ?? rawXiaomi.password ?? DEFAULT_CONFIG.xiaomi.password,
      hardware:
        process.env.MI_HARDWARE ?? rawXiaomi.hardware ?? DEFAULT_CONFIG.xiaomi.hardware,
      did: process.env.MI_DID ?? rawXiaomi.did ?? DEFAULT_CONFIG.xiaomi.did,
    },
    openclaw: {
      apiUrl:
        process.env.OPENCLAW_API_URL ??
        rawOpenclaw.api_url ??
        DEFAULT_CONFIG.openclaw.apiUrl,
      apiKey:
        process.env.OPENCLAW_API_KEY ??
        rawOpenclaw.api_key ??
        DEFAULT_CONFIG.openclaw.apiKey,
      model:
        process.env.OPENCLAW_MODEL ??
        rawOpenclaw.model ??
        DEFAULT_CONFIG.openclaw.model,
      systemPrompt:
        process.env.OPENCLAW_SYSTEM_PROMPT ??
        rawOpenclaw.system_prompt ??
        DEFAULT_CONFIG.openclaw.systemPrompt,
    },
    channel: {
      pollInterval: parseFloat(
        process.env.CHANNEL_POLL_INTERVAL ??
          String(rawChannel.poll_interval ?? DEFAULT_CONFIG.channel.pollInterval)
      ),
      triggerPrefix:
        process.env.CHANNEL_TRIGGER_PREFIX ??
        rawChannel.trigger_prefix ??
        DEFAULT_CONFIG.channel.triggerPrefix,
      maxHistory: parseInt(
        process.env.CHANNEL_MAX_HISTORY ??
          String(rawChannel.max_history ?? DEFAULT_CONFIG.channel.maxHistory),
        10
      ),
      ttsChunkSize: parseInt(
        process.env.CHANNEL_TTS_CHUNK_SIZE ??
          String(rawChannel.tts_chunk_size ?? DEFAULT_CONFIG.channel.ttsChunkSize),
        10
      ),
      stopXiaoaiResponse:
        process.env.CHANNEL_STOP_XIAOAI_RESPONSE !== undefined
          ? process.env.CHANNEL_STOP_XIAOAI_RESPONSE === "true"
          : rawChannel.stop_xiaoai_response ?? DEFAULT_CONFIG.channel.stopXiaoaiResponse,
      keywordBlacklist:
        process.env.CHANNEL_KEYWORD_BLACKLIST ??
        rawChannel.keyword_blacklist ??
        DEFAULT_CONFIG.channel.keywordBlacklist,
    },
  };

  return config;
}

/**
 * 验证配置是否完整。
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (!config.xiaomi.username) {
    errors.push("缺少小米账号 (MI_USER 或 xiaomi.username)");
  }
  if (!config.xiaomi.password) {
    errors.push("缺少小米密码 (MI_PASS 或 xiaomi.password)");
  }
  if (!config.openclaw.apiUrl) {
    errors.push("缺少 OpenClaw API 地址 (OPENCLAW_API_URL 或 openclaw.api_url)");
  }

  return errors;
}

/**
 * 解析关键词黑名单为数组。
 */
export function getBlacklistKeywords(config: AppConfig): string[] {
  if (!config.channel.keywordBlacklist) return [];
  return config.channel.keywordBlacklist
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}
