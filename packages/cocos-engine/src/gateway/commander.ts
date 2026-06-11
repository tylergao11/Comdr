// ============================================================
// Commander — LLM 调用抽象层
// 支持 DeepSeek / OpenAI 兼容 API，带重试 + 指数退避
// ============================================================

import * as https from 'https';
import * as http from 'http';
import { cloneJson } from '../foundation/value-kit.js';
import { makeError, ERR_CANCELLED, ERR_CMD_NETWORK, ERR_CMD_RATE_LIMIT, ERR_CMD_AUTH, ERR_CMD_SERVER_ERROR, ERR_CMD_MAX_RETRIES } from '../errors/error-codes.js';
import { LLM_MAX_TOKENS, LLM_TEMPERATURE, LLM_MAX_RETRIES, LLM_ERROR_DETAIL_MAX } from '../foundation/constants.js';

export interface CommanderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CommanderOptions {
  messages: CommanderMessage[];
  request?: string;
  context?: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CommanderResponse {
  text: string;
  raw: Record<string, unknown>;
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

// ===== HTTP 请求 =====

function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
  timeoutMs: number = 120000
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: timeoutMs,
    };

    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          data: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Aborted'));
      }, { once: true });
    }

    req.write(body);
    req.end();
  });
}

// ===== 重试逻辑 =====

function classifyHttpError(status: number): { retryable: boolean; code: string } {
  if (status === 429) return { retryable: true, code: ERR_CMD_RATE_LIMIT };
  if (status === 401 || status === 403) return { retryable: false, code: ERR_CMD_AUTH };
  if (status >= 500) return { retryable: true, code: ERR_CMD_SERVER_ERROR };
  return { retryable: false, code: ERR_CMD_NETWORK };
}

/** 统一的 HTTP 响应处理：状态码检查 + JSON 解析。OpenAI/Anthropic 共用。 */
function _handleHttpResponse(resp: { status: number; data: string }): Record<string, unknown> {
  // 状态码错误 → 抛出分类好的错误
  if (resp.status !== 200) {
    const classified = classifyHttpError(resp.status);
    let detail: string = resp.data;
    try {
      const parsed = JSON.parse(resp.data);
      detail = parsed.error?.message || parsed.message || resp.data;
    } catch { /* raw text */ }
    throw {
      ...makeError(classified.code, `HTTP ${resp.status}: ${String(detail).slice(0, LLM_ERROR_DETAIL_MAX)}`),
      retryable: classified.retryable || resp.status >= 500,
    };
  }

  // JSON 解析
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(resp.data);
  } catch {
    throw { ...makeError(ERR_CMD_NETWORK, 'Invalid JSON response'), retryable: false };
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== 主调用 =====

export async function callCommander(opts: CommanderOptions): Promise<CommanderResponse> {
  const maxRetries = LLM_MAX_RETRIES;
  let lastError: string = '';
  let lastCode: string = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw makeError(ERR_CANCELLED, 'Aborted by user');
    }

    try {
      const result = await _callOnce(opts);
      return result;
    } catch (err) {
      const error = err as { code?: string; message?: string; retryable?: boolean };
      lastError = error.message || String(err);
      lastCode = error.code || ERR_CMD_NETWORK;

      // 不可重试的错误直接抛
      if (error.retryable === false) break;

      // 最后一次不等待
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
        await sleep(delay);
      }
    }
  }

  throw makeError(lastCode || ERR_CMD_MAX_RETRIES, `Commander call failed after ${maxRetries} retries: ${lastError}`);
}

async function _callOnce(opts: CommanderOptions): Promise<CommanderResponse> {
  if (opts.provider === 'anthropic') {
    return _callAnthropic(opts);
  }
  return _callOpenAiCompatible(opts);
}

/** 标记 message 前缀缓存：缓存到最后一条之前的所有消息（前缀跨轮次不变） */
function markCacheable(msgs: Array<{ role: string; content: string }>): Array<Record<string, unknown>> {
  if (msgs.length < 2) return msgs.map((m) => ({ role: m.role, content: m.content }));
  // 最后一条是当轮新注入的反馈+状态，不缓存；它之前的所有消息跨轮次不变
  return msgs.map((m, i) => {
    const block: Record<string, unknown> = { role: m.role, content: m.content };
    if (i === msgs.length - 2) block.cache_control = { type: 'ephemeral' };
    return block;
  });
}

// ===== OpenAI 兼容 API (DeepSeek / OpenAI / etc.) =====

async function _callOpenAiCompatible(opts: CommanderOptions): Promise<CommanderResponse> {
  const url = `${opts.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
  };

  // OpenAI 路径: system 在 messages[0]，单独标 cache_control；其余走 markCacheable
  const openAiMessages = opts.messages.map((m, i) => {
    const block: Record<string, unknown> = { role: m.role, content: m.content };
    if (i === 0 && m.role === 'system') block.cache_control = { type: 'ephemeral' };
    return block;
  });
  const nonSystem = openAiMessages.slice(1).map(m => ({ role: m.role as string, content: m.content as string }));
  const allMessages = [openAiMessages[0], ...markCacheable(nonSystem)];

  const body = JSON.stringify({
    model: opts.model,
    messages: allMessages,
    temperature: opts.temperature ?? LLM_TEMPERATURE,
    max_tokens: opts.maxTokens ?? LLM_MAX_TOKENS,
  });

  const resp = await httpsPost(url, headers, body, opts.signal, 120000);
  const data = _handleHttpResponse(resp);

  const choices = data.choices as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined;
  if (!choices || choices.length === 0) {
    throw { ...makeError(ERR_CMD_NETWORK, 'No choices in response'), retryable: false };
  }

  const text = choices[0].message?.content || '';
  const finishReason = choices[0].finish_reason;

  const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;

  return {
    text,
    raw: data,
    finishReason,
    usage: usage
      ? { promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0 }
      : undefined,
  };
}

// ===== Anthropic Messages API =====

async function _callAnthropic(opts: CommanderOptions): Promise<CommanderResponse> {
  const url = `${opts.baseUrl}/messages`;
  const headers: Record<string, string> = {
    'x-api-key': opts.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  };

  // Anthropic: system prompt 是顶层字段，不在 messages 数组中
  const systemMsg = opts.messages.find((m) => m.role === 'system');
  const chatMessages = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const bodyObj: Record<string, unknown> = {
    model: opts.model,
    messages: markCacheable(chatMessages),
    temperature: opts.temperature ?? LLM_TEMPERATURE,
    max_tokens: opts.maxTokens ?? LLM_MAX_TOKENS,
  };
  if (systemMsg) {
    bodyObj.system = [{ type: 'text', text: systemMsg.content, cache_control: { type: 'ephemeral' } }];
  }

  const body = JSON.stringify(bodyObj);

  const resp = await httpsPost(url, headers, body, opts.signal, 120000);
  const data = _handleHttpResponse(resp);

  // Anthropic 响应格式: content[{type, text}] → 提取 text
  const contentArray = data.content as Array<{ type: string; text?: string }> | undefined;
  if (!contentArray || contentArray.length === 0) {
    throw { ...makeError(ERR_CMD_NETWORK, 'No content in Anthropic response'), retryable: false };
  }

  const text = contentArray
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');

  const finishReason = data.stop_reason as string | undefined;

  const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;

  return {
    text,
    raw: data,
    finishReason,
    usage: usage
      ? { promptTokens: usage.input_tokens || 0, completionTokens: usage.output_tokens || 0 }
      : undefined,
  };
}
