/**
 * XiaoAi ↔ OpenClaw Channel Bridge
 *
 * 核心逻辑：
 * 1. 持续轮询小爱同学的对话记录
 * 2. 检测到新的用户提问后，判断是否需要转发
 * 3. 停止小爱自带回复（可选）
 * 4. 将提问发送给 OpenClaw
 * 5. 将 OpenClaw 的回复通过小爱 TTS 播报
 */

import { type AppConfig, getBlacklistKeywords } from "./config.js";
import { XiaoAiService } from "./mi-service.js";
import { OpenClawClient, type ChatMessage } from "./openclaw-client.js";
import { logger } from "./logger.js";

export class XiaoAiChannel {
  private config: AppConfig;
  private xiaoai: XiaoAiService;
  private openclaw: OpenClawClient;

  // 状态
  private lastQuery = "";
  private lastTimestamp = 0;
  private conversationHistory: ChatMessage[] = [];
  private running = false;
  private errorCount = 0;
  private readonly maxErrors = 10;

  constructor(config: AppConfig) {
    this.config = config;

    this.xiaoai = new XiaoAiService({
      username: config.xiaomi.username,
      password: config.xiaomi.password,
      hardware: config.xiaomi.hardware,
      did: config.xiaomi.did,
    });

    this.openclaw = new OpenClawClient({
      apiUrl: config.openclaw.apiUrl,
      apiKey: config.openclaw.apiKey,
      model: config.openclaw.model,
      systemPrompt: config.openclaw.systemPrompt,
    });
  }

  /**
   * 初始化所有服务。
   */
  async initialize(): Promise<void> {
    logger.info("══════════════════════════════════════════════════");
    logger.info("OpenClaw XiaoAi Channel 正在启动...");
    logger.info("══════════════════════════════════════════════════");

    await this.xiaoai.initialize();
    logger.info("所有服务初始化完成");
  }

  /**
   * 启动主循环。
   */
  async run(): Promise<void> {
    this.running = true;
    const pollInterval = this.config.channel.pollInterval;

    logger.info(`Channel 已启动，轮询间隔: ${pollInterval}s`);
    if (this.config.channel.triggerPrefix) {
      logger.info(`触发前缀: "${this.config.channel.triggerPrefix}"`);
    } else {
      logger.info("未设置触发前缀，所有对话将转发至 OpenClaw");
    }

    const blacklist = getBlacklistKeywords(this.config);
    if (blacklist.length) {
      logger.info(`关键词黑名单: ${blacklist.join(", ")}`);
    }

    // 获取一次当前对话以避免处理旧消息
    const conv = await this.xiaoai.getLastConversation();
    if (conv) {
      this.lastQuery = conv.query;
      this.lastTimestamp = conv.timestamp;
      logger.info(`跳过已有对话: "${this.lastQuery}"`);
    }

    logger.info("等待新的用户对话...");

    while (this.running) {
      try {
        await this.pollAndProcess();
        this.errorCount = 0;
      } catch (err) {
        this.errorCount++;
        logger.error(
          `处理异常 (${this.errorCount}/${this.maxErrors}): ${err}`
        );

        if (this.errorCount >= this.maxErrors) {
          logger.error(`连续错误达到 ${this.maxErrors} 次，停止服务`);
          break;
        }

        // 指数退避
        const wait = Math.min(pollInterval * 2 ** this.errorCount, 60);
        await sleep(wait * 1000);
        continue;
      }

      await sleep(pollInterval * 1000);
    }
  }

  /**
   * 轮询一次并处理新对话。
   */
  private async pollAndProcess(): Promise<void> {
    const conv = await this.xiaoai.getLastConversation();
    if (!conv) return;

    const { query, timestamp } = conv;

    // 检查是否是新的对话
    if (query === this.lastQuery && timestamp === this.lastTimestamp) {
      return;
    }

    this.lastQuery = query;
    this.lastTimestamp = timestamp;

    logger.info(`► 用户说: "${query}"`);

    // 检查是否需要转发
    if (!this.shouldForward(query)) {
      logger.debug("  跳过（不满足转发条件）");
      return;
    }

    // 提取实际查询内容（去除触发前缀）
    const actualQuery = this.extractQuery(query);
    if (!actualQuery) return;

    // 停止小爱自带回复
    if (this.config.channel.stopXiaoaiResponse) {
      await this.xiaoai.stopResponse();
      await sleep(300);
    }

    // 发送给 OpenClaw
    logger.info(`→ 转发至 OpenClaw: "${actualQuery}"`);
    const startTime = Date.now();

    let response: string;
    try {
      response = await this.openclaw.chat(
        actualQuery,
        this.getHistory()
      );
    } catch (err) {
      const errorMsg = "抱歉，我现在无法回答，请稍后再试。";
      logger.error(`OpenClaw 请求失败: ${err}`);
      await this.xiaoai.textToSpeech(errorMsg);
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const preview =
      response.length > 100 ? response.slice(0, 100) + "..." : response;
    logger.info(`← OpenClaw 回复 (${elapsed}s): "${preview}"`);

    // 更新对话历史
    this.addToHistory(actualQuery, response);

    // 通过小爱 TTS 播报
    await this.xiaoai.ttsLongText(response, this.config.channel.ttsChunkSize);
  }

  /**
   * 判断是否应该将此查询转发给 OpenClaw。
   */
  private shouldForward(query: string): boolean {
    const q = query.toLowerCase().trim();
    if (!q) return false;

    // 关键词黑名单检查
    for (const keyword of getBlacklistKeywords(this.config)) {
      if (q.includes(keyword)) {
        logger.debug(`  命中黑名单关键词: "${keyword}"`);
        return false;
      }
    }

    // 触发前缀检查
    if (this.config.channel.triggerPrefix) {
      const prefix = this.config.channel.triggerPrefix.toLowerCase();
      if (!q.startsWith(prefix)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 从用户输入中提取实际查询内容（去除触发前缀）。
   */
  private extractQuery(query: string): string {
    if (this.config.channel.triggerPrefix) {
      const prefix = this.config.channel.triggerPrefix;
      if (query.toLowerCase().startsWith(prefix.toLowerCase())) {
        query = query.slice(prefix.length);
      }
    }
    return query.trim();
  }

  /**
   * 获取对话历史（限制长度）。
   */
  private getHistory(): ChatMessage[] {
    const max = this.config.channel.maxHistory * 2;
    if (this.conversationHistory.length > max) {
      this.conversationHistory = this.conversationHistory.slice(-max);
    }
    return [...this.conversationHistory];
  }

  /**
   * 添加一轮对话到历史记录。
   */
  private addToHistory(userMsg: string, assistantMsg: string): void {
    this.conversationHistory.push(
      { role: "user", content: userMsg },
      { role: "assistant", content: assistantMsg }
    );

    const max = this.config.channel.maxHistory * 2;
    if (this.conversationHistory.length > max) {
      this.conversationHistory = this.conversationHistory.slice(-max);
    }
  }

  /**
   * 清除对话历史。
   */
  clearHistory(): void {
    this.conversationHistory = [];
    logger.info("对话历史已清除");
  }

  /**
   * 停止 Channel。
   */
  stop(): void {
    this.running = false;
    logger.info("Channel 正在停止...");
  }
}

// ─── 工具 ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
