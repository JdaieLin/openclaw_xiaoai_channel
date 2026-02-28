#!/usr/bin/env node

/**
 * OpenClaw XiaoAi Channel - 入口点
 *
 * 用法:
 *   npx openclaw-xiaoai                      # 使用默认配置
 *   npx openclaw-xiaoai -c config.yaml       # 指定配置文件
 *   npx openclaw-xiaoai --debug              # 调试模式
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { Command } from "commander";

import { loadConfig, validateConfig, type AppConfig } from "./config.js";
import { XiaoAiChannel } from "./channel.js";
import { logger, setDebug } from "./logger.js";

const VERSION = "0.1.0";

// ─── CLI ─────────────────────────────────────────────────────

const program = new Command()
  .name("openclaw-xiaoai")
  .description("OpenClaw XiaoAi Channel - 将小爱同学变成 OpenClaw 的对话通道")
  .version(VERSION)
  .option("-c, --config <path>", "配置文件路径", "config.yaml")
  .option("-e, --env-file <path>", ".env 文件路径", ".env")
  .option("-d, --debug", "启用调试模式", false)
  .parse(process.argv);

const opts = program.opts<{
  config: string;
  envFile: string;
  debug: boolean;
}>();

// ─── 启动 ────────────────────────────────────────────────────

async function main() {
  // 加载 .env
  const envPath = resolve(opts.envFile);
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
    logger.debug(`已加载 .env: ${envPath}`);
  }

  // 日志
  setDebug(opts.debug);

  // 加载配置
  const configPath = resolve(opts.config);
  const configExists = existsSync(configPath);
  const config: AppConfig = loadConfig(configExists ? configPath : undefined);

  // 验证
  const errors = validateConfig(config);
  if (errors.length) {
    console.error("\n配置错误:");
    for (const err of errors) {
      console.error(`  • ${err}`);
    }
    console.error("\n请检查 config.yaml 或设置对应的环境变量。");
    console.error("参考 config.yaml.example 和 .env.example\n");
    process.exit(1);
  }

  // 启动信息
  console.log(`\n  OpenClaw XiaoAi Channel v${VERSION}`);
  console.log(`  设备型号: ${config.xiaomi.hardware}`);
  console.log(`  OpenClaw: ${config.openclaw.apiUrl}`);
  console.log(`  轮询间隔: ${config.channel.pollInterval}s`);
  if (config.channel.triggerPrefix) {
    console.log(`  触发前缀: "${config.channel.triggerPrefix}"`);
  }
  console.log();

  // 创建 Channel
  const channel = new XiaoAiChannel(config);

  // 信号处理
  const shutdown = () => {
    console.log("\n收到退出信号，正在优雅关闭...");
    channel.stop();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 启动
  try {
    await channel.initialize();
    await channel.run();
  } catch (err) {
    logger.error(`致命错误: ${err}`);
    if (opts.debug && err instanceof Error) {
      console.error(err.stack);
    }
    process.exit(1);
  }

  logger.info("Channel 已停止");
}

main();
