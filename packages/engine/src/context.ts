/**
 * context.ts — 结构化锚定迭代摘要
 *
 * 来源：Factory AI Anchored Iterative Summarization + Claude Code 5-Layer Compaction
 *
 * ★ 核心升级：从 README 的简单"四级压缩"升级为 Factory AI 的结构化锚定方案。
 *
 * 触发阈值:
 *   FILL_LINE  = 80% token 预算 → 触发压缩
 *   DRAIN_LINE = 60% token 预算 → 压缩后目标
 *
 * 压缩管线（顺序执行，从便宜到贵）:
 *
 *   Stage 1: Observe (观察掩码)
 *     └→ 对超过 5 轮的历史消息，只保留 tool call name + ok/error，删除完整 output
 *
 *   Stage 2: Anchor (结构化锚定摘要) ← Factory AI 方案
 *     └→ 调用轻量 LLM summarize 最近被截断的消息段
 *     └→ 合并到持久化的结构化摘要中（不是全量重新生成！）
 *
 *   Stage 3: Collapse (虚拟投影) ← Claude Code 方案
 *     └→ 非破坏性：只在内存中替换，不修改持久化消息
 *     └→ 将旧消息替换为 [summary token] 占位符
 *
 *   Stage 4: Compact (完整压缩) ← 最后手段
 *     └→ 调 LLM 生成完整压缩版本
 *     └→ 保留双窗口内容的 anchor 引用
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  Message,
  SessionState,
  StructuredSummary,
  CompactionResult,
  CompactionLevel,
} from '@comdr/core/types';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import { SYSTEM, MASKED_PREFIX, MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import { summarizeToolOutput, summarizeSegmentText } from './smart-truncate.js';
import { extractAndParseJSON } from './utils.js';

// ============================================================================
// §1 常量（已迁移至 @comdr/core SYSTEM——参见 types.ts）
// ============================================================================

// ============================================================================
// §2 ContextManager 类
// ============================================================================

export class ContextManager {
  private readonly llm: IDeepSeekClient;
  private persistentSummary: StructuredSummary | null = null;
  /** 压缩/摘要过程中消耗的 token 数（由 Engine 轮询后累加到 session） */
  private _tokensSpent = 0;

  constructor(llm: IDeepSeekClient) {
    this.llm = llm;
  }

  /** 获取本轮压缩消耗的 token 数，读取后自动清零 */
  getTokensSpentThisTurn(): number {
    const t = this._tokensSpent;
    this._tokensSpent = 0;
    return t;
  }

  // --------------------------------------------------------------------------
  // preCompact() — 压缩前检查
  // --------------------------------------------------------------------------

  /**
   * 压缩前检查——如果超出阈值，执行压缩管线
   *
   * @param session  当前会话
   * @param maxTokens  Token 预算上限
   * @returns 压缩后的消息数组
   */
  async preCompact(
    session: SessionState,
    maxTokens: number,
  ): Promise<Message[]> {
    // ★ 用消息的实际 token 估算值判断，而非 session.tokensUsed（累计值）
    //   否则 Stage 4 压缩后消息已缩至 2K，但 session.tokensUsed 仍 160K+
    //   会误判每轮都需要重复压缩
    const currentTokens = this.estimateTokens(session.messages);
    const threshold = this.fillLine(maxTokens);

    // 未达阈值 → 不压缩
    if (currentTokens < threshold) {
      return session.messages;
    }

    // ★ 缓存 token 估算（避免对同一 messages 重复计算 3 次）
    let cachedEstimate = currentTokens;
    const recalcAndCheck = (msgs: Message[]) => {
      cachedEstimate = this.estimateTokens(msgs);
      return cachedEstimate >= this.fillLine(maxTokens);
    };

    // Stage 1: Observe
    let messages = this.applyObservationMask(session.messages);
    let level: CompactionLevel = 'snip_micro';

    // Stage 2: Anchor
    if (recalcAndCheck(messages)) {
      // ★ 提取被 Stage 1 掩码截断的原始消息
      const maskedSegment = this.extractMaskedSegment(
        session.messages,
        messages,
      );
      const segmentSummary = await this.summarizeSegment(maskedSegment);
      this.persistentSummary = this.mergeSummary(
        this.persistentSummary,
        segmentSummary,
      );
      messages = this.replaceWithAnchor(messages, this.persistentSummary);
      level = 'collapse';
    }

    // Stage 3: Collapse
    if (recalcAndCheck(messages)) {
      messages = this.collapseHistory(messages);
      level = 'collapse';
    }

    // Stage 4: Compact（最后手段）
    // ★ 必须重新估算——Stage 3 collapseHistory() 可能已大幅减少消息量
    if (recalcAndCheck(messages)) {
      const compacted = await this.fullCompact(session);
      messages = compacted.messages;
      level = 'auto_compact';
    }

    return messages;
  }

  // --------------------------------------------------------------------------
  // Stage 1: Observe — 观察掩码
  // --------------------------------------------------------------------------

  /**
   * Stage 1: Observe (观察掩码)
   *
   * 对超过 SYSTEM.COMPACTION_OBSERVE_MASK_TURNS 轮的历史消息:
   *   - 保留 tool call name + ok/error
   *   - 删除完整 tool output 内容
   */
  applyObservationMask(messages: Message[]): Message[] {
    // 统计 tool result 数量，保留最后的 N 条完整
    let toolResultCount = 0;
    const indices: number[] = [];

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role === MESSAGE_ROLE.TOOL) {
        indices.push(i);
        toolResultCount++;
      }
    }

    // 最后 SYSTEM.COMPACTION_OBSERVE_MASK_TURNS * 2 条 tool result 保留完整
    const keepCount = SYSTEM.COMPACTION_OBSERVE_MASK_TURNS * 2;
    const maskIndices = new Set(indices.slice(keepCount));

    return messages.map((msg, i) => {
      if (!maskIndices.has(i)) return msg;

      // 掩码：只保留 ok/error + 工具名
      const summary = this.summarizeToolResult(msg.content ?? '');

      return {
        ...msg,
        content: `${MASKED_PREFIX} ${summary}`,
      };
    });
  }

  /**
   * 将 tool result 智能压缩——提取错误/测试结果/有意义的摘要，
   * 而非盲取首行截断。
   *
   * @see smart-truncate.ts summarizeToolOutput()
   */
  private summarizeToolResult(content: string): string {
    return summarizeToolOutput(content);
  }

  // --------------------------------------------------------------------------
  // Stage 2: Anchor — 结构化锚定摘要
  // --------------------------------------------------------------------------

  /**
   * 提取被 Stage 1 掩码截断的原始消息
   * 对比 original[masked] 找到 content 被替换为 "[masked]" 的消息
   */
  private extractMaskedSegment(
    original: Message[],
    masked: Message[],
  ): Message[] {
    const result: Message[] = [];
    for (let i = 0; i < original.length && i < masked.length; i++) {
      const orig = original[i]!;
      const mask = masked[i]!;
      // 检测 content 是否被截断
      if (
        orig.content &&
        mask.content &&
        mask.content.startsWith(MASKED_PREFIX) &&
        orig.content !== mask.content
      ) {
        result.push(orig);
      }
    }
    return result;
  }

  /**
   * 调用轻量 LLM summarise 一段消息
   */
  private async summarizeSegment(
    segment: Message[],
  ): Promise<StructuredSummary> {
    const segmentText = segment
      .map((m) => {
        const role = m.role;
        const content = m.content ?? '';
        const tools = m.tool_calls
          ? m.tool_calls.map((tc) => `  tool: ${tc.function.name}(${tc.function.arguments})`)
          : [];
        return `[${role}] ${content}${tools.length ? '\n' + tools.join('\n') : ''}`;
      })
      .join('\n');

    const prompt = [
      'Summarize the following conversation segment into structured JSON.',
      'Include the approximate turn number when noting decisions.',
      'Output format (JSON only, no other text):',
      '{',
      '  "sessionIntent": "what the user wanted to accomplish",',
      '  "fileModifications": [{"path":"...","action":"created|modified|deleted","summary":"..."}],',
      '  "decisions": [{"what":"...","why":"...","turn":0}],',
      '  "nextSteps": ["..."],',
      '  "openQuestions": ["..."]',
      '}',
      '',
      'Conversation:',
      summarizeSegmentText(segmentText, SYSTEM.SUMMARY_INPUT_MAX_CHARS),
    ].join('\n');

    try {
      const response = await this.llm.chat({
        messages: [
          { role: MESSAGE_ROLE.SYSTEM, content: prompt },
        ],
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: SYSTEM.SUMMARY_LLM_MAX_TOKENS,
      });

      // ★ 记录 token 消耗
      this._tokensSpent +=
        response.usage.promptTokens +
        response.usage.completionTokens +
        response.usage.reasoningTokens;

      if (response.message.content) {
        const parsed = extractAndParseJSON<StructuredSummary>(response.message.content);
        if (parsed) return parsed;
      }
    } catch {
      // LLM 摘要失败 → 返回空摘要（静默降级）
    }

    return {
      sessionIntent: '',
      fileModifications: [],
      decisions: [],
      nextSteps: [],
      openQuestions: [],
    };
  }

  /**
   * 合并新摘要到持久化摘要
   *
   * ★ 关键：不是全量重新生成，而是增量合并
   */
  private mergeSummary(
    existing: StructuredSummary | null,
    incoming: StructuredSummary,
  ): StructuredSummary {
    if (!existing) return incoming;

    // ★ 按路径去重 fileModifications（同路径的新摘要覆盖旧）
    const fileMap = new Map<string, StructuredSummary['fileModifications'][number]>();
    for (const fm of existing.fileModifications) fileMap.set(fm.path, fm);
    for (const fm of incoming.fileModifications) fileMap.set(fm.path, fm);
    const fileMods = [...fileMap.values()].slice(-SYSTEM.COMPACTION_MAX_FILE_MODIFICATIONS);

    // ★ nextSteps: 合并而非替换——保留旧步骤中未被新步骤覆盖的部分
    const mergedNext = [
      ...existing.nextSteps.filter(s => !incoming.nextSteps.includes(s)),
      ...incoming.nextSteps,
    ].slice(-SYSTEM.MAX_NEXT_STEPS);

    return {
      sessionIntent: incoming.sessionIntent || existing.sessionIntent,
      fileModifications: fileMods,
      decisions: [
        ...existing.decisions,
        ...incoming.decisions,
      ].slice(-SYSTEM.COMPACTION_MAX_DECISIONS),
      nextSteps: mergedNext,
      openQuestions: [
        ...existing.openQuestions,
        ...incoming.openQuestions,
      ].slice(-SYSTEM.MAX_OPEN_QUESTIONS),
    };
  }

  /**
   * 用持久化摘要替换被截断的消息段
   */
  private replaceWithAnchor(
    messages: Message[],
    summary: StructuredSummary,
  ): Message[] {
    const anchorText = this.serializeSummary(summary);

    return [
      {
        role: MESSAGE_ROLE.SYSTEM,
        content: `<compacted_summary>\n${anchorText}\n</compacted_summary>`,
      },
      ...messages,
    ];
  }

  /**
   * 序列化 StructuredSummary → 文本
   */
  private serializeSummary(summary: StructuredSummary): string {
    const parts: string[] = [];

    if (summary.sessionIntent) {
      parts.push(`Goal: ${summary.sessionIntent}`);
    }

    if (summary.fileModifications.length > 0) {
      parts.push('Files:');
      for (const fm of summary.fileModifications) {
        parts.push(`  - ${fm.action} ${fm.path}: ${fm.summary}`);
      }
    }

    if (summary.decisions.length > 0) {
      parts.push('Decisions:');
      for (const d of summary.decisions) {
        parts.push(`  - ${d.what} (because: ${d.why}, turn ${d.turn})`);
      }
    }

    if (summary.nextSteps.length > 0) {
      parts.push(`Next: ${summary.nextSteps.join('; ')}`);
    }

    if (summary.openQuestions.length > 0) {
      parts.push(`Open: ${summary.openQuestions.join('; ')}`);
    }

    return parts.join('\n');
  }

  // --------------------------------------------------------------------------
  // Stage 3: Collapse — 虚拟投影
  // --------------------------------------------------------------------------

  /**
   * Stage 3: Collapse (虚拟投影)
   *
   * 非破坏性——只在内存中替换，不修改持久化消息。
   * 将旧消息替换为 [summary token] 占位符。
   */
  private collapseHistory(messages: Message[]): Message[] {
    // 保留最后一个 user 消息后的所有内容
    const lastUserIdx = findLastIndex(
      messages,
      (m) => m.role === MESSAGE_ROLE.USER,
    );

    if (lastUserIdx <= 1) return messages; // 太少，不坍缩

    const preserved = messages.slice(lastUserIdx);
    const collapsed = messages.slice(0, lastUserIdx);

    // ★ 按 assistant 消息数估算轮数（每轮 1 个 assistant 消息）
    const turnCount = collapsed.filter(
      (m) => m.role === MESSAGE_ROLE.ASSISTANT,
    ).length;

    return [
      {
        role: MESSAGE_ROLE.SYSTEM,
        content: `[history collapsed: ${collapsed.length} messages, ~${turnCount} turns]`,
      },
      ...preserved,
    ];
  }

  // --------------------------------------------------------------------------
  // Stage 4: Compact — 完整压缩
  // --------------------------------------------------------------------------

  /**
   * Stage 4: Compact (完整压缩)
   *
   * 调 LLM 生成完整压缩版本，保留双窗口内容的 anchor 引用。
   */
  private async fullCompact(
    session: SessionState,
  ): Promise<{ messages: Message[]; result: CompactionResult }> {
    try {
      const compactPrompt = this.buildCompactPrompt(session);
      const response = await this.llm.chat({
        messages: [
          { role: MESSAGE_ROLE.SYSTEM, content: compactPrompt },
          {
            role: MESSAGE_ROLE.USER,
            content: 'Generate the compacted summary. Output JSON only.',
          },
        ],
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: SYSTEM.FULL_COMPACT_MAX_TOKENS,
      });

      // ★ 记录 token 消耗
      this._tokensSpent +=
        response.usage.promptTokens +
        response.usage.completionTokens +
        response.usage.reasoningTokens;

      let injectedSummary: string | null = null;
      if (response.message.content) {
        const parsed = extractAndParseJSON<{ summary: string }>(response.message.content);
        injectedSummary = parsed?.summary ?? response.message.content;
      }

      // ★ 构建 state/intent window 摘要（确保 LLM 知道已完成的操作）
      const windowContext = this.buildWindowContext(session);

      // 保留 system prompt + anchor + state/intent window + 压缩摘要
      const contextParts: string[] = [];
      if (windowContext) contextParts.push(windowContext);
      if (injectedSummary) contextParts.push(injectedSummary);
      const contextContent = contextParts.length > 0
        ? `<compacted_context>\n${contextParts.join('\n\n')}\n</compacted_context>`
        : '<compacted_context />';

      const result: Message[] = [
        { role: MESSAGE_ROLE.SYSTEM, content: SYSTEM_PROMPT_FALLBACK },
        { role: MESSAGE_ROLE.SYSTEM, content: contextContent },
        {
          role: MESSAGE_ROLE.USER,
          content: `Continue working on: ${session.currentInput}`,
        },
      ];

      return {
        messages: result,
        result: {
          level: 'auto_compact',
          messagesAfter: result.length,
          tokensAfter: this.estimateTokens(result),
          injectedSummary,
        },
      };
    } catch {
      // LLM 压缩失败 → 极端降级：保留 state window + 用户输入
      const windowContext = this.buildWindowContext(session);
      const fallbackMessages: Message[] = [];
      if (windowContext) {
        fallbackMessages.push({
          role: MESSAGE_ROLE.SYSTEM,
          content: `<compacted_context>\n${windowContext}\n</compacted_context>`,
        });
      }
      fallbackMessages.push({
        role: MESSAGE_ROLE.USER,
        content: `Continue: ${session.currentInput}`,
      });

      return {
        messages: fallbackMessages,
        result: {
          level: 'auto_compact',
          messagesAfter: fallbackMessages.length,
          tokensAfter: this.estimateTokens(fallbackMessages),
          injectedSummary: null,
        },
      };
    }
  }

  /**
   * 构造压缩 prompt
   */
  private buildCompactPrompt(session: SessionState): string {
    return [
      'You are a context compressor. Summarize the following coding session.',
      'Output as JSON: {"summary": "compact summary of all key actions, decisions, and current state"}',
      '',
      `Task: ${session.currentInput}`,
      `Turns: ${session.turn}`,
      `Files modified: ${session.stateWindow.length}`,
      session.stateWindow.length > 0
        ? `Recent: ${session.stateWindow.map((e) => `${e.key}: ${e.text}`).join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 从双窗口构建紧凑的上下文摘要文本
   *
   * ★ Stage 4 压缩后 LLM 丢失了所有已完成操作的记忆，
   * 此方法将 state/intent window 序列化为文本，注入到压缩后的 context 中。
   *
   * @returns 格式化的双窗口文本，无数据时返回空串
   */
  private buildWindowContext(session: SessionState): string {
    const parts: string[] = [];

    if (session.stateWindow.length > 0) {
      const stateLines = session.stateWindow.map(
        (e) => `  - [${e.key}] ${e.text}`,
      );
      parts.push(`Completed actions:\n${stateLines.join('\n')}`);
    }

    if (session.intentWindow.length > 0) {
      const intentLines = session.intentWindow.map(
        (e) => `  - [${e.key}] ${e.why}`,
      );
      parts.push(`Intent:\n${intentLines.join('\n')}`);
    }

    return parts.join('\n\n');
  }

  // --------------------------------------------------------------------------
  // 工具方法
  // --------------------------------------------------------------------------

  /**
   * 80% token 预算 → 触发压缩
   */
  private fillLine(maxTokens: number): number {
    return Math.floor(
      maxTokens * SYSTEM.COMPACTION_THRESHOLD_SNIP,
    );
  }

  /**
   * Token 估算——分段加权（CJK / 代码 / 英文用不同比率）
   *
   * - 中文/日文/韩文: ~1.5 chars/token（Huffman 编码密集）
   * - 代码/JSON: ~3 chars/token（符号多）
   * - 英文/文本: ~3.5 chars/token（保守取值）
   *
   * ★ 必须计入 reasoning_content——DeepSeek 每轮助理消息可能附带
   *   数千字符的推理链，忽略会导致严重低估 token 量。
   */
  private estimateTokens(messages: Message[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4; // 每条消息 ~4 token overhead
      if (msg.content) {
        tokens += this.estimateTextTokens(msg.content);
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTextTokens(msg.reasoning_content);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          tokens += 6; // tool call overhead
          tokens += tc.function.name.length / 3;
          tokens += tc.function.arguments.length / 3; // JSON 密集
        }
      }
    }
    return Math.ceil(tokens);
  }

  /**
   * 单段文本的 token 估算——根据 CJK 占比加权
   */
  private estimateTextTokens(text: string): number {
    const cjkCount = (text.match(/[一-鿿㐀-䶿　-〿＀-￯]/g) || []).length;
    const otherCount = text.length - cjkCount;
    // CJK: ~1.5 chars/token, 非 CJK: ~3.5 chars/token
    return cjkCount / 1.5 + otherCount / 3.5;
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 获取持久化摘要（用于 episodic memory 存储）
   */
  getPersistentSummary(): StructuredSummary | null {
    return this.persistentSummary;
  }

  /**
   * 设置持久化摘要（从 episodic memory 恢复）
   */
  setPersistentSummary(summary: StructuredSummary): void {
    this.persistentSummary = summary;
  }

  /**
   * 重置（新会话）
   */
  reset(): void {
    this.persistentSummary = null;
    this._tokensSpent = 0;
  }
}

// ============================================================================
// §3 辅助函数
// ============================================================================

function findLastIndex<T>(
  arr: T[],
  predicate: (item: T) => boolean,
): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

/**
 * Fallback system prompt（压缩后使用，不含完整规则）
 */
const SYSTEM_PROMPT_FALLBACK =
  'You are Comdr, a coding agent. Continue working on the task.';
