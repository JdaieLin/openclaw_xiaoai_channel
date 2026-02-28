/**
 * OpenClaw API 客户端
 *
 * 兼容 OpenAI Chat Completions API 格式，支持流式和非流式响应。
 */

import { logger } from "./logger.js";

// ─── 类型定义 ────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: {
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
}

// ─── OpenClaw 客户端 ────────────────────────────────────────

export class OpenClawClient {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private systemPrompt: string;

  constructor(opts: {
    apiUrl: string;
    apiKey?: string;
    model?: string;
    systemPrompt?: string;
  }) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model ?? "default";
    this.systemPrompt = opts.systemPrompt ?? "";
  }

  /**
   * 构建请求头。
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * 构建消息列表。
   */
  private buildMessages(
    userMessage: string,
    history?: ChatMessage[]
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }

    if (history?.length) {
      messages.push(...history);
    }

    messages.push({ role: "user", content: userMessage });

    return messages;
  }

  /**
   * 发送消息并获取完整响应（非流式）。
   */
  async chat(
    userMessage: string,
    conversationHistory?: ChatMessage[]
  ): Promise<string> {
    const messages = this.buildMessages(userMessage, conversationHistory);
    const payload = {
      model: this.model,
      messages,
      stream: false,
    };

    const url = `${this.apiUrl}/v1/chat/completions`;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        logger.error(`OpenClaw API 错误 (HTTP ${resp.status}): ${errorText}`);
        throw new Error(`OpenClaw API 返回错误: HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as ChatCompletionResponse;
      const content = data.choices[0]?.message?.content ?? "";
      logger.debug(`OpenClaw 回复: ${content.slice(0, 100)}...`);
      return content;
    } catch (err) {
      if (err instanceof TypeError) {
        logger.error(`OpenClaw API 网络错误: ${err.message}`);
        throw new Error(`无法连接到 OpenClaw API (${url}): ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * 发送消息并流式获取响应。
   */
  async *chatStream(
    userMessage: string,
    conversationHistory?: ChatMessage[]
  ): AsyncGenerator<string, void, undefined> {
    const messages = this.buildMessages(userMessage, conversationHistory);
    const payload = {
      model: this.model,
      messages,
      stream: true,
    };

    const url = `${this.apiUrl}/v1/chat/completions`;

    const resp = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      logger.error(`OpenClaw API 错误 (HTTP ${resp.status}): ${errorText}`);
      throw new Error(`OpenClaw API 返回错误: HTTP ${resp.status}`);
    }

    if (!resp.body) {
      throw new Error("响应体为空");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let data = trimmed;
          if (data.startsWith("data: ")) {
            data = data.slice(6);
          }
          if (data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data);
            const content = chunk.choices?.[0]?.delta?.content ?? "";
            if (content) yield content;
          } catch {
            logger.debug(`跳过非 JSON 行: ${data.slice(0, 50)}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 流式获取但返回完整文本（适合 TTS 场景）。
   */
  async chatStreamFull(
    userMessage: string,
    conversationHistory?: ChatMessage[]
  ): Promise<string> {
    const parts: string[] = [];
    for await (const chunk of this.chatStream(
      userMessage,
      conversationHistory
    )) {
      parts.push(chunk);
    }
    return parts.join("");
  }
}
