/**
 * 小爱同学音箱服务封装
 *
 * 通过 mi-service-lite 与小爱同学交互：
 * - 设备发现与连接
 * - 获取用户最新对话记录
 * - TTS 语音播报
 * - 播放控制
 */

import { getMiNA, type MiNA } from "mi-service-lite";
import { logger } from "./logger.js";

export interface Conversation {
  query: string;
  answer: string;
  timestamp: number;
}

export class XiaoAiService {
  private username: string;
  private password: string;
  private hardware: string;
  private targetDid: string;
  private mina: MiNA | undefined;

  constructor(opts: {
    username: string;
    password: string;
    hardware?: string;
    did?: string;
  }) {
    this.username = opts.username;
    this.password = opts.password;
    this.hardware = opts.hardware ?? "LX04";
    this.targetDid = opts.did ?? "";
  }

  /**
   * 初始化：登录小米账号并发现目标设备。
   */
  async initialize(): Promise<void> {
    logger.info("正在登录小米账号...");

    this.mina = await getMiNA({
      userId: this.username,
      password: this.password,
      did: this.targetDid || this.hardware,
    });

    if (!this.mina) {
      throw new Error(
        `无法初始化 MiNA 服务。请检查：\n` +
          `  1. 小米账号和密码是否正确\n` +
          `  2. 设备型号/DID 是否正确 (当前: hardware=${this.hardware}, did=${this.targetDid})\n` +
          `  3. 小爱音箱是否在米家 App 中已绑定`
      );
    }

    const device = this.mina.account.device;
    logger.info(`✓ 已连接设备: ${device.name} (${device.hardware})`);
    logger.debug(`  DeviceID: ${device.deviceID}`);
    logger.debug(`  MiotDID:  ${device.miotDID}`);
    logger.debug(`  状态:     ${device.presence}`);
  }

  /**
   * 获取最新一条对话记录。
   */
  async getLastConversation(): Promise<Conversation | null> {
    if (!this.mina) throw new Error("服务未初始化");

    try {
      const convs = await this.mina.getConversations({ limit: 2 });

      if (!convs?.records?.length) {
        return null;
      }

      const last = convs.records[0];
      const query = last.query?.trim() ?? "";
      let answer = "";

      if (last.answers?.length) {
        const first = last.answers[0];
        if (first.type === "TTS" && first.tts?.text) {
          answer = first.tts.text;
        }
      }

      return {
        query,
        answer,
        timestamp: last.time ?? 0,
      };
    } catch (err) {
      logger.error(`获取对话记录异常: ${err}`);
      return null;
    }
  }

  /**
   * 通过小爱同学 TTS 播报文本。
   */
  async textToSpeech(text: string): Promise<void> {
    if (!this.mina) throw new Error("服务未初始化");

    try {
      await this.mina.play({ tts: text });
      logger.debug(`TTS 已发送: ${text.slice(0, 80)}...`);
    } catch (err) {
      logger.error(`TTS 发送失败: ${err}`);
      throw err;
    }
  }

  /**
   * 停止小爱同学当前的回复/播放。
   */
  async stopResponse(): Promise<void> {
    if (!this.mina) throw new Error("服务未初始化");

    try {
      await this.mina.pause();
      logger.debug("已停止小爱回复");
    } catch (err) {
      logger.debug(`停止播放异常（可能正常）: ${err}`);
    }
  }

  /**
   * 将长文本分段通过 TTS 播报。
   */
  async ttsLongText(text: string, chunkSize = 200): Promise<void> {
    text = text.trim();
    if (!text) return;

    if (text.length <= chunkSize) {
      await this.textToSpeech(text);
      return;
    }

    const chunks = splitText(text, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        // 等待前一段播报完成（粗略估算：中文约 0.2 秒/字）
        const waitMs = Math.max(chunks[i - 1].length * 200, 2000);
        await sleep(waitMs);
      }
      await this.textToSpeech(chunks[i]);
      logger.debug(`TTS 分段 ${i + 1}/${chunks.length} 已发送`);
    }
  }
}

// ─── 工具函数 ────────────────────────────────────────────────

/**
 * 在句子边界处分割文本。
 */
function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  const separators = ["。", "！", "？", "；", "\n", ".", "!", "?", ";", "，", ","];

  while (text) {
    if (text.length <= maxLength) {
      chunks.push(text);
      break;
    }

    let splitPos = -1;
    for (const sep of separators) {
      const pos = text.lastIndexOf(sep, maxLength);
      if (pos > maxLength / 3) {
        splitPos = pos + sep.length;
        break;
      }
    }

    if (splitPos <= 0) {
      splitPos = maxLength;
    }

    const chunk = text.slice(0, splitPos).trim();
    if (chunk) chunks.push(chunk);
    text = text.slice(splitPos).trim();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
