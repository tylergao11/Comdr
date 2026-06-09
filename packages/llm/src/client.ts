/**
 * client.ts — DeepSeek API 客户端核心
 *
 * 实现 IDeeepSeekClient 契约（Contract A）:
 *   1. chat() — 非流式调用
 *   2. chatStream() — SSE 流式调用
 *   3. 重试退避: 429/5xx → 1s→2s→4s, max 3; 401/403 → 不重试
 *   4. thinking 参数: 顶层字段，启用时删除 tool_choice/temperature/top_p
 *   5. reasoning_content 完整保留并回传
 *   6. 不发送 cache_control（DeepSeek 全自动前缀缓存）
 *
 * @agent Agent 2 — 此文件由 Agent 2 维护
 */

import type {
  AgentConfig,
  ChatParams,
  ChatResponse,
  Message,
  ToolCall,
  ThinkingConfig,
  TokenUsage,
  AgentEvent,
} from '@comdr/core/types';
import { AGENT_EVENT, SYSTEM, MESSAGE_ROLE, THINKING_TYPE, THINKING_EFFORT, sleep } from '@comdr/core';
import { DeepSeekAuthError, DeepSeekRetryError } from '@comdr/core/contracts';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import { serializeTools } from './prompt-cache.js';

// ============================================================================
// §1 常量
// ============================================================================

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const BETA_BASE_URL = 'https://api.deepseek.com/beta';
const MAX_RETRIES = SYSTEM.LLM_MAX_RETRIES;
const RETRY_BASE_MS = SYSTEM.LLM_RETRY_BASE_MS;

// ============================================================================
// §2 类型定义
// ============================================================================

/**
 * DeepSeek API 请求体
 */
interface DeepSeekRequestBody {
  model: string;
  messages: Message[];
  max_tokens: number;
  stream?: boolean;
  tools?: unknown[];
  thinking?: { type: string };
  reasoning_effort?: string;
  tool_choice?: string;
  temperature?: number;
  top_p?: number;
  response_format?: { type: string };
}

/**
 * DeepSeek API 非流式响应
 */
interface DeepSeekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekChoice[];
  usage: DeepSeekUsage;
}

interface DeepSeekChoice {
  index: number;
  message: DeepSeekMessage;
  finish_reason: string;
}

interface DeepSeekMessage {
  role: string;
  content: string | null;
  tool_calls?: DeepSeekToolCall[];
  reasoning_content?: string;
}

interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

/**
 * SSE chunk 结构
 */
interface DeepSeekChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: DeepSeekChunkChoice[];
  usage?: DeepSeekUsage;
}

interface DeepSeekChunkChoice {
  index: number;
  delta: DeepSeekDelta;
  finish_reason: string | null;
}

interface DeepSeekDelta {
  role?: string;
  content?: string | null;
  tool_calls?: DeepSeekDeltaToolCall[];
  reasoning_content?: string;
}

interface DeepSeekDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ============================================================================
// §3 DeepSeekClient 类
// ============================================================================

export class DeepSeekClient implements IDeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  /** R1 (deepseek-reasoner) 禁止传 reasoning_content，V4 必须传 */
  private readonly isReasoner: boolean;

  constructor(config: AgentConfig['llm']) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.isReasoner = isReasonerModel(config.model);
  }

  // --------------------------------------------------------------------------
  // chat() — 非流式调用
  // --------------------------------------------------------------------------

  /**
   * 非流式调用 DeepSeek API
   *
   * @throws DeepSeekAuthError 401/403
   * @throws DeepSeekRetryError 429/5xx 重试耗尽后
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const body = this.buildRequestBody(params, false);
    const url = this.getEndpoint(params);

    const response = await this.fetchWithRetry(url, body, params.signal);

    const data = (await response.json()) as DeepSeekResponse;

    const choice = data.choices[0];
    if (!choice) {
      throw new Error('DeepSeek API returned no choices');
    }

    const message = this.convertMessage(choice.message);
    const usage = this.convertUsage(data.usage);

    return {
      message,
      finishReason: choice.finish_reason,
      usage,
    };
  }

  // --------------------------------------------------------------------------
  // chatStream() — SSE 流式调用
  // --------------------------------------------------------------------------

  /**
   * 流式调用 DeepSeek API（SSE）
   *
   * onEvent 在每个 SSE chunk 到达时同步调用:
   *   - text_delta:     逐 token 推送
   *   - thinking_delta: reasoning_content 流式片段
   *   - tool_call:      tool call 构建完成后一次性推送
   *
   * ★ reasoning_content 片段以 thinking_delta 事件推送
   *
   * @throws DeepSeekAuthError 401/403
   * @throws DeepSeekRetryError 429/5xx 重试耗尽后
   */
  async chatStream(
    params: ChatParams,
    onEvent: (event: AgentEvent) => void,
  ): Promise<ChatResponse> {
    const body = this.buildRequestBody(params, true);
    const url = this.getEndpoint(params);

    const response = await this.fetchWithRetry(url, body, params.signal);

    if (!response.body) {
      throw new Error('Response body is null — stream not available');
    }

    // 流式解析
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    // 累积状态
    const accumulated: {
      content: string;
      reasoning: string;
      toolCalls: Map<number, AccumulatedToolCall>;
    } = {
      content: '',
      reasoning: '',
      toolCalls: new Map(),
    };

    let finalUsage: DeepSeekUsage | null = null;
    let finishReason = 'stop';
    let buffer = '';
    let sseParseFailures = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 行解析
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 最后一个可能是不完整的行

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();

        if (payload === '[DONE]') continue;

        try {
          const chunk = JSON.parse(payload) as DeepSeekChunk;

          if (chunk.usage) {
            finalUsage = chunk.usage;
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const delta = choice.delta;

          // reasoning_content 流式片段 → thinking_delta 事件
          if (delta.reasoning_content) {
            accumulated.reasoning += delta.reasoning_content;
            onEvent({
              type: AGENT_EVENT.THINKING_DELTA,
              content: delta.reasoning_content,
            });
          }

          // content 流式片段 → text_delta 事件
          if (delta.content) {
            accumulated.content += delta.content;
            onEvent({
              type: AGENT_EVENT.TEXT_DELTA,
              content: delta.content,
            });
          }

          // tool_calls 增量处理
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = accumulated.toolCalls.get(tc.index) ?? {
                id: '',
                functionName: '',
                functionArgs: '',
              };

              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.functionName += tc.function.name;
              if (tc.function?.arguments) existing.functionArgs += tc.function.arguments;

              accumulated.toolCalls.set(tc.index, existing);
            }
          }
        } catch {
          // JSON 解析失败 → 跳过（非标准 SSE payload）
          // ★ 累计失败超过阈值时警告——避免静默丢弃所有响应
          sseParseFailures++;
          if (sseParseFailures === 50) {
            console.warn(
              '[Comdr] SSE parse: 50 consecutive non-JSON data lines. ' +
              'DeepSeek response format may have changed.',
            );
          }
        }
      }
    }

    // 构建最终的 ToolCall[] 并推送事件
    const toolCalls: ToolCall[] = [];
    for (const [, acc] of accumulated.toolCalls) {
      const tc: ToolCall = {
        id: acc.id,
        type: 'function',
        function: {
          name: acc.functionName,
          arguments: acc.functionArgs,
        },
      };
      toolCalls.push(tc);
      onEvent({ type: AGENT_EVENT.TOOL_CALL, call: tc });
    }

    // 构建最终 Message（包含 reasoning_content）
    // ★ 空字符串也必须保留——V4 有 59% 概率返回空 reasoning_content
    const message: Message = {
      role: MESSAGE_ROLE.ASSISTANT,
      content: accumulated.content || null,
      reasoning_content: accumulated.reasoning, // 保留空串，不转换为 undefined
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage = this.convertUsage(finalUsage);

    return {
      message,
      finishReason,
      usage,
    };
  }

  // --------------------------------------------------------------------------
  // 内部: 请求体构造
  // --------------------------------------------------------------------------

  /**
   * 构造 DeepSeek API 请求体
   *
   * 关键规则:
   *   - thinking 是顶层字段（不是 extra_body.thinking）
   *   - thinking 启用时: 删除 tool_choice / temperature / top_p
   *   - 不发送 cache_control（DeepSeek 全自动前缀缓存）
   *   - tools 序列化使用 sort_keys（保证缓存命中）
   */
  private buildRequestBody(
    params: ChatParams,
    stream: boolean,
  ): DeepSeekRequestBody {
    // ★ R1 (deepseek-reasoner) 禁止传 reasoning_content，需剥离
    const messages = this.isReasoner
      ? params.messages.map(stripReasoningContent)
      : params.messages;

    const body: DeepSeekRequestBody = {
      model: this.model,
      messages,
      max_tokens: params.maxTokens ?? this.maxTokens,
      stream,
    };

    // 工具定义（sort_keys 保证前缀缓存命中）
    if (params.tools && params.tools.length > 0) {
      body.tools = JSON.parse(serializeTools(params.tools)) as unknown[];
    }

    // thinking 参数（顶层字段）
    this.applyThinkingConfig(body, params.thinking);

    return body;
  }

  /**
   * 应用 thinking 配置到请求体
   */
  private applyThinkingConfig(
    body: DeepSeekRequestBody,
    thinking: ThinkingConfig,
  ): void {
    if (thinking.type === THINKING_TYPE.DISABLED) {
      body.thinking = { type: THINKING_TYPE.DISABLED };
      return;
    }

    // thinking 启用
    body.thinking = { type: THINKING_TYPE.ENABLED };
    body.reasoning_effort = thinking.effort;

    // ★ thinking 启用时: 删除 tool_choice / temperature / top_p
    // 这些参数设置不报错但无效，删除以减少 payload 大小
    delete body.tool_choice;
    delete body.temperature;
    delete body.top_p;
  }

  /**
   * 获取 API endpoint
   */
  private getEndpoint(params: ChatParams): string {
    // ★ 检测是否包含 prefix: true 的 assistant message
    // 有 → 使用 beta Chat Prefix Completion endpoint
    const hasPrefix = params.messages.some(
      (m) => m.role === MESSAGE_ROLE.ASSISTANT && m.prefix === true,
    );

    const baseUrl = hasPrefix ? BETA_BASE_URL : this.baseUrl;
    return `${baseUrl}/chat/completions`;
  }

  // --------------------------------------------------------------------------
  // 内部: 重试逻辑
  // --------------------------------------------------------------------------

  /**
   * fetch + 智能重试
   *
   * 重试: 429 / 5xx → 指数退避 1s→2s→4s，max 3 次
   * 不重试: 401 / 403 → 直接抛 DeepSeekAuthError
   */
  private async fetchWithRetry(
    url: string,
    body: DeepSeekRequestBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        // 401/403 → 不重试
        if (response.status === 401 || response.status === 403) {
          const text = await response.text().catch(() => '');
          throw new DeepSeekAuthError(
            `DeepSeek API 认证失败 (${response.status}): ${text}`,
            response.status as 401 | 403,
          );
        }

        // 429 / 5xx → 重试
        if (response.status === 429 || response.status >= 500) {
          lastError = new DeepSeekRetryError(
            `DeepSeek API 返回 ${response.status}`,
            response.status,
            attempt + 1,
          );

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
            await sleep(delay);
            continue;
          }

          // 重试耗尽
          throw lastError;
        }

        // 2xx → 成功
        if (response.ok) return response;

        // 其他错误
        throw new Error(
          `DeepSeek API 返回意外状态 ${response.status}: ${await response.text().catch(() => '')}`,
        );
      } catch (err) {
        // 不重试网络错误（可能永久失败）
        if (err instanceof DeepSeekAuthError || err instanceof DeepSeekRetryError) {
          throw err;
        }
        // AbortSignal 取消
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error('DeepSeek API 请求失败（未知原因）');
  }

  // --------------------------------------------------------------------------
  // 内部: 类型转换
  // --------------------------------------------------------------------------

  /**
   * DeepSeek API message → @comdr/core Message
   * ★ reasoning_content 必须原样保留——空字符串也必须回传（59% 概率，丢 = 400）
   */
  private convertMessage(dsMsg: DeepSeekMessage): Message {
    const msg: Message = {
      role: dsMsg.role as Message['role'],
      content: dsMsg.content,
    };

    // ★ reasoning_content 必须原样保留，包括空字符串
    // V4: 必须传（即使为空），R1: 禁止传（由 buildRequestBody 剥离）
    if (dsMsg.reasoning_content !== undefined) {
      msg.reasoning_content = dsMsg.reasoning_content;
    }

    // 转换 tool_calls
    if (dsMsg.tool_calls && dsMsg.tool_calls.length > 0) {
      msg.tool_calls = dsMsg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    return msg;
  }

  /**
   * DeepSeek usage → @comdr/core TokenUsage
   */
  private convertUsage(dsUsage: DeepSeekUsage | null | undefined): TokenUsage {
    return {
      promptTokens: dsUsage?.prompt_tokens ?? 0,
      completionTokens: dsUsage?.completion_tokens ?? 0,
      reasoningTokens: dsUsage?.reasoning_tokens ?? 0,
      cacheHitTokens: dsUsage?.prompt_cache_hit_tokens ?? 0,
      cacheMissTokens: dsUsage?.prompt_cache_miss_tokens ?? 0,
    };
  }
}

// ============================================================================
// §4 工具类型 + 辅助函数
// ============================================================================

interface AccumulatedToolCall {
  id: string;
  functionName: string;
  functionArgs: string;
}

// ============================================================================
// §5 R1 vs V4 模型区分
// ============================================================================

/**
 * 判断是否为 deepseek-reasoner (R1) 模型
 *
 * R1: 禁止传 reasoning_content，传了反而 400
 * V4 (thinking 启用): 必须传 reasoning_content
 *
 * @param model 模型名
 * @returns true = R1，需要剥离 reasoning_content
 */
export function isReasonerModel(model: string): boolean {
  // R1 系列模型
  const reasonerPatterns = [
    /^deepseek-reasoner/i,
    /^deepseek-r1/i,
  ];
  return reasonerPatterns.some((p) => p.test(model));
}

/**
 * 剥离 Message 中的 reasoning_content 字段
 * 用于 R1 模型——传了 reasoning_content 会导致 400 错误
 */
function stripReasoningContent(msg: Message): Message {
  if (msg.reasoning_content === undefined) return msg;
  const { reasoning_content: _, ...rest } = msg;
  return rest as Message;
}
