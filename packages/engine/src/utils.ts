/**
 * utils.ts — engine 内部共享工具函数
 *
 * 这些纯函数被多个 engine 子系统使用，提取到此处避免重复实现。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

/** 安全解析 tool call arguments（JSON 字符串 → 对象），失败返回空对象 */
export function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 从 LLM 响应中提取并解析 JSON。
 *
 * LLM 约 5% 概率返回畸形 JSON（包裹在 markdown fence 中、多余文本前后、尾随逗号）。
 * 此函数做三级降级尝试，避免静默丢失结果。
 *
 * 1. 直接 JSON.parse(content)
 * 2. 从 ```json ... ``` fence 中提取
 * 3. 从 { 到最后一个 } 提取
 *
 * @returns 解析结果，失败返回 null
 */
export function extractAndParseJSON<T = Record<string, unknown>>(
  content: string | null,
): T | null {
  if (!content) return null;

  // 策略 1: 直接解析
  try {
    return JSON.parse(content) as T;
  } catch {
    // continue
  }

  // 策略 2: 提取 markdown code fence
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]) as T;
    } catch {
      // continue
    }
  }

  // 策略 3: 提取 { 到最后一个 }
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      // fall through to null
    }
  }

  return null;
}
