/**
 * reflection.ts — MIRROR 双重反思
 *
 * 来源：Live-SWE-agent 轻量反射 + Claude Code 权限管线
 *
 * Intra-reflection（执行前预判，规则驱动，不调 LLM）:
 *   1. 循环检测: 同一 tool + 同一 args 连续 ≥3 次
 *   2. 范围漂移: 操作超出当前 task 定义的范围
 *
 * Inter-reflection（执行后审查，失败时调 LLM）:
 *   1. 结果验证: 工具输出是否符合预期？
 *   2. 根因分析: 如果失败，为什么？
 *   3. 质量评估: 修改质量如何？
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  IntraReflection,
  InterReflection,
  ToolCall,
  ToolResult,
  Message,
  SessionState,
  Route,
  LSPDiagnostic,
  DiagnosticSnapshot,
} from '@comdr/core/types';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import {
  SYSTEM,
  ALL_TOOLS_SENTINEL,
  MESSAGE_ROLE,
  THINKING_TYPE,
  THINKING_EFFORT,
  ERROR_CATEGORY,
  TERMINATION_REASON,
} from '@comdr/core';
import { extractAndParseJSON, safeParseArgs } from './utils.js';
import { summarizeToolOutput } from './smart-truncate.js';

/** Self-correct 返回结果 */
export interface SelfCorrectResult {
  /** 是否生成并返回了修正 */
  corrected: boolean;
  /** 修正后的 tool call arguments */
  correctedArgs?: Record<string, unknown>;
  /** LLM 解释（为什么错了） */
  explanation?: string;
}

/**
 * ★ LSP 诊断差值纠正决策——确定性、不调 LLM。
 *
 * decision 取值:
 *   'accept'  → 纯改善或无变化，正常流程继续
 *   'rollback' → 纯恶化，应回滚文件变更
 *   'retry'    → 混合（有改善也有新错误），应将 feedback 注入 Agent 让它再修
 */
export interface LSPCorrectionDecision {
  /** 决策类型 */
  decision: 'accept' | 'rollback' | 'retry';
  /** 给 Agent 的反馈文本 */
  feedback: string;
}

// ============================================================================
// §1 反思消息常量
// ============================================================================

const REFLECTION_MESSAGES = {
  LOOP_DETECTED:
    'You have made the same tool call 3 times. Stop and reconsider.',
  SCOPE_DRIFT:
    'This operation seems outside the current task scope.',
  SCOPE_DRIFT_ESCALATED:
    'Scope drifted for 3 consecutive turns. Task is out of control — aborting.',
  EMPTY_CALL: 'Empty tool call name',
} as const;

/** 无需 LLM 分析的确定性错误类别——直接返回预写反馈，跳过 API 调用。 */
const TRIVIAL_ERRORS: ReadonlySet<string> = new Set([
  ERROR_CATEGORY.PERMISSION_DENIED,
  ERROR_CATEGORY.SCHEMA_INVALID,
  ERROR_CATEGORY.TIMEOUT,
]);

const TRIVIAL_FEEDBACK: Record<string, string> = {
  [ERROR_CATEGORY.PERMISSION_DENIED]:
    'Tool was denied by permission check. Use a read-only alternative or reconsider the approach.',
  [ERROR_CATEGORY.SCHEMA_INVALID]:
    'Tool arguments failed schema validation. Double-check parameter names and types.',
  [ERROR_CATEGORY.TIMEOUT]:
    'Tool execution timed out. Consider reducing the scope (smaller file, fewer files, simpler command).',
};

// ============================================================================
// §2 ReflectionEngine 类
// ============================================================================

export class ReflectionEngine {
  private readonly llm: IDeepSeekClient;
  /** 最近 3 轮的工具调用签名（用于循环检测） */
  private recentCallSignatures: string[] = [];
  /** 连续范围漂移轮数（用于升级到 abort） */
  private scopeDriftCount = 0;
  /** 反思/分析过程中消耗的 token 数（由 Engine 轮询后累加到 session） */
  private _tokensSpent = 0;

  constructor(llm: IDeepSeekClient) {
    this.llm = llm;
  }

  /** 获取本轮反思消耗的 token 数，读取后自动清零 */
  getTokensSpentThisTurn(): number {
    const t = this._tokensSpent;
    this._tokensSpent = 0;
    return t;
  }

  // --------------------------------------------------------------------------
  // Intra-reflection（执行前预判）
  // --------------------------------------------------------------------------

  /**
   * 规则驱动的执行前预判（不调 LLM）
   *
   * 检查三项:
   *   1. 循环检测: 同一 tool + 同一 args 连续 ≥3 次 → abort
   *   2. 范围漂移: 操作超出当前 task 定义的范围 → warning
   *   3. 空调用: tool name 或 args 为空 → skip
   */
  intra(
    call: ToolCall,
    session: SessionState,
    route: Route,
  ): IntraReflection {
    const signature = this.callSignature(call);

    // 记录本次调用签名
    this.recentCallSignatures.push(signature);
    if (this.recentCallSignatures.length > SYSTEM.MAX_CALL_SIGNATURES) {
      this.recentCallSignatures.shift();
    }

    // 检查 1: 循环检测
    const loopDetected = this.detectLoop(signature);
    if (loopDetected) {
      return {
        skip: true,
        skipReason: REFLECTION_MESSAGES.LOOP_DETECTED,
        abort: true,
        abortReason: TERMINATION_REASON.LOOP_DETECTED,
        loopDetected: true,
        scopeDrift: false,
      };
    }

    // 检查 2: 范围漂移（★ 升级制：连续3轮 → abort）
    const scopeDrift = this.detectScopeDrift(call, route);
    if (scopeDrift) {
      this.scopeDriftCount++;
      if (this.scopeDriftCount >= SYSTEM.LOOP_DETECTION_THRESHOLD) {
        return {
          skip: true,
          skipReason: REFLECTION_MESSAGES.SCOPE_DRIFT_ESCALATED,
          abort: true,
          abortReason: TERMINATION_REASON.SCOPE_DRIFT,
          loopDetected: false,
          scopeDrift: true,
          warning: REFLECTION_MESSAGES.SCOPE_DRIFT_ESCALATED,
        };
      }
      return {
        skip: false,
        abort: false,
        loopDetected: false,
        scopeDrift: true,
        warning: REFLECTION_MESSAGES.SCOPE_DRIFT,
      };
    }
    // Reset scope drift counter on clean turn
    this.scopeDriftCount = 0;

    // 检查 3: 空调用
    if (!call.function.name) {
      return {
        skip: true,
        skipReason: REFLECTION_MESSAGES.EMPTY_CALL,
        abort: false,
        loopDetected: false,
        scopeDrift: false,
      };
    }

    // 通过
    return {
      skip: false,
      abort: false,
      loopDetected: false,
      scopeDrift: false,
    };
  }

  /**
   * 生成 tool call 的唯一签名（用于循环检测）
   */
  private callSignature(call: ToolCall): string {
    return `${call.function.name}(${call.function.arguments})`;
  }

  /**
   * 检测循环：
   *   1. 相同签名连续出现 ≥ LOOP_DETECTION_THRESHOLD 次
   *   2. 两个签名严格交替 (A→B→A→B→A→B) — 也是循环
   */
  private detectLoop(signature: string): boolean {
    const threshold = SYSTEM.LOOP_DETECTION_THRESHOLD;
    const recent = this.recentCallSignatures.slice(-threshold);

    if (recent.length < threshold) return false;

    // 模式 1: 全是同一个签名
    if (recent.every((s) => s === signature)) return true;

    // 模式 2: 两个签名严格交替 (A→B→A→B...)
    // 至少有 2 个不同值，且每个奇数位置相同、每个偶数位置相同
    if (threshold >= 3) {
      const even = recent[0]!;
      const odd = recent[1]!;
      if (even === odd) return false; // 需要两个不同签名
      let alternating = true;
      for (let i = 0; i < recent.length; i++) {
        const expected = i % 2 === 0 ? even : odd;
        if (recent[i] !== expected) { alternating = false; break; }
      }
      if (alternating) return true;
    }

    return false;
  }

  /**
   * 检测范围漂移：
   *   - 操作的文件路径是否与当前任务类型匹配
   *   - 当前实现：简单检查——非 all 模式下的工具名是否在允许列表中
   */
  private detectScopeDrift(call: ToolCall, route: Route): boolean {
    if (route.allowedTools.includes(ALL_TOOLS_SENTINEL)) return false;
    return !route.allowedTools.includes(call.function.name);
  }

  // --------------------------------------------------------------------------
  // Inter-reflection（执行后审查）
  // --------------------------------------------------------------------------

  /**
   * 执行后审查（失败时调 LLM）
   *
   * 检查三项:
   *   1. 结果验证: 工具输出是否符合预期？
   *   2. 根因分析: 如果失败，为什么？
   *   3. 质量评估: 修改质量如何？
   */
  async inter(
    call: ToolCall,
    result: ToolResult,
    _session: SessionState,
  ): Promise<InterReflection> {
    if (result.ok) {
      return {
        acceptable: true,
        needsRollback: false,
        feedback: null,
      };
    }

    // ★ 确定性错误 → 跳过 LLM，直接用预写反馈（节省 1-2s 延迟 + token）
    const category = result.errorCategory;
    if (category && TRIVIAL_ERRORS.has(category)) {
      return {
        acceptable: false,
        needsRollback: result.snapshotId !== undefined,
        feedback: TRIVIAL_FEEDBACK[category] ??
          `Tool failed with ${category}.`,
        rootCause: category,
        errorCategory: category,
      };
    }

    // ★ 复杂错误 → 调 LLM 做根因分析
    const analysis = await this.analyzeFailure(call, result);
    return analysis;
  }

  /**
   * 调用 LLM 分析工具失败原因
   */
  private async analyzeFailure(
    call: ToolCall,
    result: ToolResult,
  ): Promise<InterReflection> {
    const messages: Message[] = [
      {
        role: MESSAGE_ROLE.SYSTEM,
        content:
          'Analyze why this tool call failed and suggest next steps. ' +
          'Output as JSON: {"rootCause":"...", "shouldRollback":true/false, "feedback":"..."}',
      },
      {
        role: MESSAGE_ROLE.USER,
        content: [
          `Tool: ${call.function.name}(${call.function.arguments})`,
          `Error Category: ${result.errorCategory ?? ERROR_CATEGORY.EXECUTION_ERROR}`,
          `Content: ${result.content ?? '(null)'}`,
          result.diffSummary
            ? `Diff Summary: ${result.diffSummary}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    try {
      const response = await this.llm.chat({
        messages,
        thinking: { type: THINKING_TYPE.DISABLED },
      });

      // ★ 记录 token 消耗
      this._tokensSpent +=
        response.usage.promptTokens +
        response.usage.completionTokens +
        response.usage.reasoningTokens;

      // 尝试解析 JSON 响应
      let rootCause = 'Unknown failure';
      let needsRollback = false;
      let feedback: string | null = null;

      const content = response.message.content;
      if (content) {
        const parsed = extractAndParseJSON<{
          rootCause?: string;
          shouldRollback?: boolean;
          feedback?: string;
        }>(content);
        if (parsed) {
          rootCause = parsed.rootCause ?? rootCause;
          needsRollback = parsed.shouldRollback ?? false;
          feedback = parsed.feedback ?? null;
        } else {
          // JSON 解析失败，使用原始文本作为 feedback
          feedback = content;
        }
      }

      return {
        acceptable: false,
        needsRollback: result.snapshotId !== undefined && needsRollback,
        feedback,
        rootCause,
        errorCategory: result.errorCategory,
      };
    } catch {
      // LLM 调用失败 → 回退到规则判断
      console.warn('[reflection] LLM analyzeFailure failed, falling back to rule-based judgment');
      return {
        acceptable: false,
        needsRollback: result.snapshotId !== undefined,
        feedback: `Tool ${call.function.name} failed with ${result.errorCategory ?? 'execution_error'}: ${result.content ?? '(no output)'}`,
        errorCategory: result.errorCategory,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Self-Correct via DeepSeek side channel (SDB Step 6 → test_failed)
  // --------------------------------------------------------------------------

  /**
   * ★ DeepSeek Self-Correct: 用 reasoning_content + Prefix Completion
   * 做单次自动修复。只在 test_failed 时触发。
   *
   * DeepSeek 三武器:
   *   1. reasoning_content 回注 — 模型看到自己当时的推理链
   *   2. thinking=enabled:max — side channel 重型推理
   *   3. Chat Prefix Completion — `prefix: true` 强制纠正姿态
   *
   * @returns 修正结果——成功时包含新的 old_string/new_string
   */
  async selfCorrect(
    call: ToolCall,
    result: ToolResult,
    reasoningContent: string,
  ): Promise<SelfCorrectResult> {
    const args = safeParseArgs(call.function.arguments);
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    const filePath = typeof args.path === 'string' ? args.path : '';

    const testOut = result.testFeedback?.output ?? '(no test output)';
    const diffSummary = result.diffSummary ?? '(no diff)';
    const failedCount = result.testFeedback?.failed ?? 0;
    const passedCount = result.testFeedback?.passed ?? 0;

    // ★ DeepSeek prefix message — forces correction posture
    const prefixContent =
      `I see the mistake. The test results show ${failedCount} failures ` +
      `(and ${passedCount} passing). The reasoning was correct but the ` +
      `implementation deviated. Here is the corrected edit:`;

    const messages: Message[] = [
      {
        role: MESSAGE_ROLE.SYSTEM,
        content:
          'You are a precise code corrector. Given (1) the original reasoning, ' +
          '(2) the exact diff that was applied, (3) the test failure output — ' +
          'determine WHY the edit failed and output the CORRECTED edit parameters.\n\n' +
          'Output as JSON only, no other text:\n' +
          '{"old_string": "the original wrong code to replace", ' +
          '"new_string": "the corrected code", ' +
          '"explanation": "one sentence explaining the root cause"}',
      },
      // ★ 原始 assistant message — 带 reasoning_content（武器 1）
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: null,
        tool_calls: [call],
        reasoning_content: reasoningContent,
      },
      // Tool result — 展示 diff + 测试输出
      {
        role: MESSAGE_ROLE.TOOL,
        content:
          `Tool: ${call.function.name}(${call.function.arguments})\n` +
          `Diff: ${diffSummary}\n` +
          `Test output (${failedCount} failed, ${passedCount} passed):\n${testOut}`,
        tool_call_id: call.id,
      },
      // User — 简洁任务描述
      {
        role: MESSAGE_ROLE.USER,
        content:
          `Fix ${filePath || 'the file'}: the edit replaced old_string with new_string ` +
          `but ${failedCount} test(s) failed. Output the CORRECTED old_string and new_string.`,
      },
      // ★ Prefix Completion（武器 3）— 强制纠正姿态
      {
        role: MESSAGE_ROLE.ASSISTANT,
        content: prefixContent,
        prefix: true,
      },
    ];

    try {
      const response = await this.llm.chat({
        messages,
        // ★ thinking=enabled:max（武器 2）— side channel 重型推理
        thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
        // ★ maxTokens 足够生成修正后的代码
        maxTokens: 4000,
      });

      this._tokensSpent +=
        response.usage.promptTokens +
        response.usage.completionTokens +
        response.usage.reasoningTokens;

      const content = response.message.content;
      if (!content) {
        return { corrected: false, explanation: 'LLM returned empty response' };
      }

      const parsed = extractAndParseJSON<{
        old_string?: string;
        new_string?: string;
        explanation?: string;
      }>(content);

      if (!parsed?.new_string) {
        return {
          corrected: false,
          explanation: parsed?.explanation ?? `LLM response not parseable: ${summarizeToolOutput(content, undefined, 200)}`,
        };
      }

      return {
        corrected: true,
        correctedArgs: {
          path: filePath,
          old_string: parsed.old_string ?? oldString,
          new_string: parsed.new_string,
        },
        explanation: parsed.explanation ?? 'Self-correct applied',
      };
    } catch (err) {
      return {
        corrected: false,
        explanation: `Self-correct LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // --------------------------------------------------------------------------
  // LSP 诊断差值纠正（确定性，不调 LLM）
  // --------------------------------------------------------------------------

  /**
   * ★ LSP 诊断差值纠正——确定性、不调 LLM。
   *
   * 和 selfCorrect() 的关系:
   *   - correctByLSP(): 处理语法/类型错误（LSP 诊断差值 → 确定性决策）
   *   - selfCorrect():  处理逻辑/测试错误（reasoning + prefix completion → LLM 决策）
   *
   * 调用顺序（在 loop.ts 中）:
   *   1. snapshot before  →  D_before
   *   2. tool execute     →  改文件
   *   3. snapshot after   →  D_after
   *   4. correctByLSP(D_before, D_after) → 决策
   *      - 纯改善 → 接受
   *      - 纯恶化 → 回滚
   *      - 有改善有恶化 → 把新错误注入 Agent 反馈，让它再修
   *   5. 如果仍有 test_failed → selfCorrect()（LLM 路径）
   *
   * ★ Lanser-CLI 论文: 这本质上就是过程奖励信号。
   *   r = α*(errors_before - errors_after) + β*safety_check
   *
   * @returns 决策结果 + 反馈文本
   */
  correctByLSP(
    before: DiagnosticSnapshot,
    after: DiagnosticSnapshot,
  ): LSPCorrectionDecision {
    const delta = this.computeDiagnosticDelta(before, after);

    // 计算分数（简化版 Lanser-CLI 奖励函数）
    const score =
      delta.fixed.length * 2    // 修复一个错误 = +2
      - delta.introduced.length * 3;  // 引入新错误 = -3（惩罚更重）

    if (score > 0 && delta.introduced.length === 0) {
      // 纯改善: 修复了 N 个错误，没引入新错误
      return {
        decision: 'accept',
        feedback: delta.fixed.length > 0
          ? `Fixed ${delta.fixed.length} LSP issue(s):\n${this.formatDiagnostics(delta.fixed)}`
          : 'No LSP issues introduced.',
      };
    }

    if (score < 0 && delta.fixed.length === 0) {
      // 纯恶化: 引入了 N 个新错误，没修复任何错误
      return {
        decision: 'rollback',
        feedback:
          `Introduced ${delta.introduced.length} new LSP issue(s):\n` +
          this.formatDiagnostics(delta.introduced),
      };
    }

    if (delta.introduced.length > 0) {
      // 混合: 有改善也有恶化 → 把新错误反馈给 Agent
      return {
        decision: 'retry',
        feedback:
          (delta.fixed.length > 0
            ? `Fixed ${delta.fixed.length} issue(s) but introduced ${delta.introduced.length} new one(s).\n`
            : `Introduced ${delta.introduced.length} new LSP issue(s).\n`) +
          `Please fix:\n${this.formatDiagnostics(delta.introduced)}`,
      };
    }

    // 无变化
    return { decision: 'accept', feedback: '' };
  }

  /**
   * ★ 计算诊断差值——确定性纯函数。
   * 可独立单元测试。
   */
  private computeDiagnosticDelta(
    before: DiagnosticSnapshot,
    after: DiagnosticSnapshot,
  ): {
    introduced: LSPDiagnostic[];
    fixed: LSPDiagnostic[];
  } {
    // 用 (line, column, code, message) 作为诊断的唯一标识
    const key = (d: LSPDiagnostic) =>
      `L${d.line}:C${d.column}:${d.code ?? ''}:${d.message}`;

    const beforeSet = new Set(before.diagnostics.map(key));
    const afterSet = new Set(after.diagnostics.map(key));

    return {
      introduced: after.diagnostics.filter(d => !beforeSet.has(key(d))),
      fixed: before.diagnostics.filter(d => !afterSet.has(key(d))),
    };
  }

  private formatDiagnostics(diags: LSPDiagnostic[]): string {
    return diags
      .map(d => `  L${d.line}:C${d.column} [${d.severity}] ${d.message}`)
      .join('\n');
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 新会话/恢复时重置循环检测器
   */
  reset(): void {
    this.recentCallSignatures = [];
    this.scopeDriftCount = 0;
    this._tokensSpent = 0;
  }
}
