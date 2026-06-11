// ============================================================
// LLM Client — DeepSeek V4 Pro 强适配
//
// ★ 只支持 DeepSeek。不做 Anthropic/OpenAI 兼容层。
//   Comdr 模式下注入 IDeepSeekClient；独立模式直连 API。
// ============================================================

// ---- Config ----

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  model: 'deepseek-v4-pro',
  maxTokens: 2000,
  temperature: 0.1,
};

// ---- Types ----

export interface LLMMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LLMResponse {
  content: string;
  reasoningContent?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  };
}

// ---- DeepSeek API types (OpenAI-compatible) ----

interface DSMessage {
  role: string;
  content: string;
}

interface DSChoice {
  index: number;
  message: {
    role: string;
    content: string;
    reasoning_content?: string;
  };
  finish_reason: string;
}

interface DSUsage {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface DSResponse {
  id: string;
  choices: DSChoice[];
  usage: DSUsage;
  model: string;
}

// ---- Client ----

export class LLMClient {
  private config: LLMConfig;

  constructor(config?: Partial<LLMConfig>) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  private getApiKey(): string {
    return this.config.apiKey
      || process.env.DEEPSEEK_API_KEY
      || '';
  }

  canCallLLM(): boolean {
    return this.getApiKey().length > 0;
  }

  getModel(): string {
    return this.config.model;
  }

  /**
   * ★ 单次 DeepSeek API 调用。
   *
   * DeepSeek API 是 OpenAI 兼容协议:
   *   POST https://api.deepseek.com/chat/completions
   *   返回 response_format: json_object 强制 JSON 输出
   *   返回 reasoning_content (V4 Pro thinking)
   *   返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens (前缀缓存)
   */
  async chat(
    messages: LLMMessage[],
    options?: { model?: string; maxTokens?: number; temperature?: number },
  ): Promise<LLMResponse> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'No DeepSeek API key. Set DEEPSEEK_API_KEY env var or pass apiKey in config.',
      );
    }

    const body = {
      model: options?.model || this.config.model,
      max_tokens: options?.maxTokens || this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
      messages: messages.map((m): DSMessage => ({
        role: m.role,
        content: m.content,
      })),
      response_format: { type: 'json_object' as const },
    };

    const resp = await fetch(
      this.config.baseUrl || 'https://api.deepseek.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `DeepSeek API ${resp.status}: ${errText.slice(0, 500)}`,
      );
    }

    const data = (await resp.json()) as DSResponse;
    const choice = data.choices[0];

    return {
      content: choice?.message?.content || '',
      reasoningContent: choice?.message?.reasoning_content,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        reasoningTokens: data.usage.reasoning_tokens ?? 0,
        cacheHitTokens: data.usage.prompt_cache_hit_tokens ?? 0,
        cacheMissTokens: data.usage.prompt_cache_miss_tokens ?? 0,
      },
    };
  }

  /**
   * ★ 调用 DeepSeek 并解析 JSON 响应。
   *
   * 处理 DeepSeek V4 可能返回的 markdown code fence 包裹:
   *   ```json\n{...}\n```
   */
  async chatJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    options?: { model?: string; maxTokens?: number; temperature?: number },
  ): Promise<T> {
    const response = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options,
    );

    const content = response.content.trim();

    // Strip ```json ... ``` fence if present
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch?.[1]?.trim() ?? content;

    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      throw new Error(
        `Failed to parse JSON from DeepSeek. Raw (500 chars): ${content.slice(0, 500)}`,
      );
    }
  }
}

// ---- Singleton ----

let _client: LLMClient | null = null;

export function getLLMClient(config?: Partial<LLMConfig>): LLMClient {
  if (!_client) _client = new LLMClient(config);
  return _client;
}

export function resetLLMClient(): void {
  _client = null;
}
