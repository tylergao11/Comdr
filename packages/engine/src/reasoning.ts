/**
 * reasoning.ts — DeepSeek reasoning_content 生命周期管理
 *
 * ★ DeepSeek 独有的子系统。其他 LLM 不需要。
 *
 * 职责:
 *   1. 从 API 响应中捕获 reasoning_content（含空字符串）
 *   2. 将 reasoning_content 注入后续 tool result 消息
 *   3. 修复历史消息中缺失的 reasoning_content
 *   4. 上下文压缩后保证 reasoning_content 不丢失
 *
 * 为什么这是 Agent 4 的职责而非 Agent 2？
 *   - Agent 2 (@comdr/llm) 是通用 DeepSeek API 客户端，不知道 agent 循环的存在
 *   - reasoning_content 的生命周期跨越多轮对话，属于 Agent 4 的编排逻辑
 *   - Agent 2 只需保证：原样返回 reasoning_content，不做任何过滤
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { Message } from '@comdr/core/types';
import { MESSAGE_ROLE } from '@comdr/core';

// ============================================================================
// §1 ReasoningManager 类
// ============================================================================

export class ReasoningManager {
  /**
   * tool_call_id → reasoning_content 映射
   */
  private cache: Map<string, string> = new Map();

  /**
   * 上一轮的 reasoning_content（用于无 tool_call 的纯文本 assistant message）
   */
  private lastReasoning: string = '';

  // --------------------------------------------------------------------------
  // capture() — 从 API 响应中捕获
  // --------------------------------------------------------------------------

  /**
   * 从 API 响应中捕获 reasoning_content。
   *
   * ★ 即使是空字符串也要保存！
   * 59% 的概率 reasoning_content 为空字符串，丢失 = 400 错误。
   *
   * 规则:
   *   - 有 tool_calls 的 assistant message → 以 tool_call[0].id 为 key 存入 cache
   *   - 无 tool_calls 的纯文本 message → 存入 lastReasoning
   */
  capture(message: Message): void {
    const rc = message.reasoning_content ?? '';
    this.lastReasoning = rc;

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        this.cache.set(tc.id, rc);
      }
    }
  }

  // --------------------------------------------------------------------------
  // inject() — 注入后续请求
  // --------------------------------------------------------------------------

  /**
   * ★ 将 reasoning_content 注入到 messages 数组中。
   *
   * DeepSeek 要求：有 tool_calls 的 assistant message 之后，
   * 所有后续请求中的该 assistant message 必须包含 reasoning_content。
   *
   * 对每条 assistant message:
   *   - 如果已有 reasoning_content → 保留
   *   - 如果有 tool_calls，从 cache 中查找 → 注入
   *   - 都没有 → 注入空字符串 ''
   *
   * @returns 注入后新的 messages 数组（不修改原数组）
   */
  inject(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (msg.role !== MESSAGE_ROLE.ASSISTANT) return msg;
      if (msg.reasoning_content !== undefined) return msg;

      // 尝试从缓存恢复
      const cached = msg.tool_calls && msg.tool_calls.length > 0
        ? this.cache.get(msg.tool_calls[0]!.id) ?? ''
        : this.lastReasoning;

      return { ...msg, reasoning_content: cached };
    });
  }

  // --------------------------------------------------------------------------
  // repairHistory() — 修复历史消息
  // --------------------------------------------------------------------------

  /**
   * 处理历史消息中的缺失 reasoning_content。
   *
   * 来自 Laravel AI PR #534 的方案：
   * 任何 assistant + tool_calls 但没有 reasoning_content 的消息，
   * 补充 reasoning_content: ''。
   *
   * @returns 修复后的新数组
   */
  repairHistory(messages: Message[]): Message[] {
    return messages.map((msg) => {
      if (
        msg.role === MESSAGE_ROLE.ASSISTANT &&
        msg.tool_calls &&
        msg.tool_calls.length > 0 &&
        msg.reasoning_content === undefined
      ) {
        return { ...msg, reasoning_content: '' };
      }
      return msg;
    });
  }

  // --------------------------------------------------------------------------
  // preserveAfterCompact() — 压缩后保留
  // --------------------------------------------------------------------------

  /**
   * 上下文压缩后，确保被压缩的消息中的 reasoning_content 不丢失。
   *
   * 压缩可能删除或替换中间的 assistant message，
   * 此方法确保剩余消息中的 reasoning_content 完整。
   */
  preserveAfterCompact(compactedMessages: Message[]): Message[] {
    return this.inject(compactedMessages);
  }

  // --------------------------------------------------------------------------
  // 工具方法
  // --------------------------------------------------------------------------

  /**
   * 获取指定 tool_call_id 对应的 reasoning_content。
   * 用于 SDB Step 6 self-correct：回注原始推理链到修复 prompt。
   *
   * @returns reasoning_content 字符串，无缓存时返回空串
   */
  getReasoning(toolCallId: string): string {
    return this.cache.get(toolCallId) ?? '';
  }

  /**
   * 获取缓存的 reasoning_content（用于调试/日志）
   */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * 清空缓存（新会话开始时调用）
   */
  clear(): void {
    this.cache.clear();
    this.lastReasoning = '';
  }
}
