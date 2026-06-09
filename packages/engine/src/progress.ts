/**
 * progress.ts — 多维 Progress Meter
 *
 * 来源：Comdr 原创 + Claude Code 的 10 种终止原因
 *
 * ★ 从简单二值"零进展=abort"升级为多维信号:
 *
 *   增益信号:
 *     - diffChanges:     代码变更行数（来自 tool_result.diffSummary）
 *     - testDelta:       测试通过数变化
 *     - infoGained:      获得了新信息（file_read/grep/glob 返回内容）
 *     - toolSuccesses:   本轮工具成功数
 *
 *   损失信号（罚分）:
 *     - stallCount:      连续零进展轮数
 *     - loopPattern:     同 tool+同 args 连续 ≥3 次
 *     - sameFileRepeat:  同一文件连续操作次数
 *     - emptyOutputCount: 空输出次数
 *
 *   三态停滞检测:
 *     - 连续 2 轮 score≤0 → warning（注入反思提示）
 *     - 连续 3 轮 score≤0 → abort
 *     - 连续 2 轮同 tool+同 args → 立即 abort
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ProgressSignal, ToolResult, ToolCall } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 评分权重常量
// ============================================================================

/**
 * 多维 Progress Signal 公式（与 README / types.ts §8 注释同步）:
 *   增益 = diffChanges*2 + max(0, testDelta)*5 + infoGained*1 + toolSuccesses*2
 *   罚分 = loopPattern? -5 : 0 + sameFileRepeat>3? -3 : 0 + emptyOutputCount* -2
 *   score = 增益 + 罚分
 */
const SCORE_WEIGHTS = {
  DIFF_CHANGES: 2,
  TEST_DELTA: 5,
  INFO_GAINED: 1,
  TOOL_SUCCESSES: 2,
  LOOP_PENALTY: 5,
  REPEAT_PENALTY: 3,
  EMPTY_PENALTY: 2,
  /** 同一文件操作次数超过此值 → 触发罚分 */
  SAME_FILE_REPEAT_THRESHOLD: 3,
  /** 单工具 infoGained 字符上限（防止超大文件歪曲得分） */
  INFO_GAINED_CAP_PER_CALL: 2000,
  /** infoGained 归一化因子（每 100 字符 = 1 分） */
  INFO_GAINED_CHARS_PER_POINT: 100,
} as const;

// ============================================================================
// §1 类型定义
// ============================================================================

/**
 * 短期记忆——最近 N 轮的工具调用历史
 */
interface TurnSnapshot {
  turn: number;
  toolCalls: { name: string; signature: string }[];
  results: { ok: boolean; diffDelta: number }[];
}

// ============================================================================
// §2 ProgressMeter 类
// ============================================================================

export class ProgressMeter {
  /** 最近 N 轮的快照 */
  private recentTurns: TurnSnapshot[] = [];
  /** 观察窗口大小 */
  private readonly windowSize = 3;
  /** 当前连续 stall count */
  private currentStallCount = 0;

  // --------------------------------------------------------------------------
  // measure() — 计算进度信号
  // --------------------------------------------------------------------------

  /**
   * ★ 从简单二值"零进展=abort"升级为多维信号
   */
  measure(
    turn: number,
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): ProgressSignal {
    // 保存本轮快照
    this.recordTurn(turn, toolCalls);

    // 取最近 windowSize 轮
    const recent = this.recentTurns.slice(-this.windowSize);

    // 增益信号
    const diffChanges = this.countDiffChanges(recent);
    const testDelta = this.countTestDelta(toolCalls);
    const infoGained = this.countInfoGained(toolCalls);
    const toolSuccesses = this.countToolSuccesses(recent);

    // 损失信号
    const loopPattern = this.detectLoopPattern(recent);
    const sameFileRepeat = this.countSameFileRepeat(toolCalls);
    const emptyOutputCount = this.countEmptyOutputs(toolCalls);

    // 综合得分
    const score =
      diffChanges * SCORE_WEIGHTS.DIFF_CHANGES +
      Math.max(0, testDelta) * SCORE_WEIGHTS.TEST_DELTA +
      infoGained * SCORE_WEIGHTS.INFO_GAINED +
      toolSuccesses * SCORE_WEIGHTS.TOOL_SUCCESSES -
      (loopPattern ? SCORE_WEIGHTS.LOOP_PENALTY : 0) -
      (sameFileRepeat > SCORE_WEIGHTS.SAME_FILE_REPEAT_THRESHOLD ? SCORE_WEIGHTS.REPEAT_PENALTY : 0) -
      emptyOutputCount * SCORE_WEIGHTS.EMPTY_PENALTY;

    // 更新 stall count
    if (score <= 0) {
      this.currentStallCount++;
    } else {
      this.currentStallCount = 0;
    }

    return {
      diffChanges,
      testDelta,
      infoGained,
      toolSuccesses,
      stallCount: this.currentStallCount,
      loopPattern,
      sameFileRepeat,
      emptyOutputCount,
      score,
    };
  }

  // --------------------------------------------------------------------------
  // 增益信号计算
  // --------------------------------------------------------------------------

  /**
   * 代码变更行数（从 diffSummary 提取）
   * 解析 "+N/-M lines" 模式
   */
  private countDiffChanges(turns: TurnSnapshot[]): number {
    let total = 0;
    for (const turn of turns) {
      for (const r of turn.results) {
        total += r.diffDelta;
      }
    }
    return total;
  }

  /**
   * 测试通过数变化
   *
   * 匹配常见测试输出格式:
   *   "3/12 tests passed" / "3/12 failed" / "Tests: 3 passed, 12 total"
   *   "3 passing (12)" / "FAIL 3 of 12"
   */
  private countTestDelta(
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): number {
    let delta = 0;
    for (const { result } of toolCalls) {
      if (!result.content) continue;
      const text = result.content;

      // 格式 1: "N/M tests passed|failed" 或 "N/M passed|failed|passing|failing"
      let match = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:tests?\s*)?(?:passed|failed|passing|failing)/i);
      if (match) {
        const pass = parseInt(match[1]!, 10);
        const total = parseInt(match[2]!, 10);
        delta += pass - (total - pass);
        continue;
      }

      // 格式 2: "Tests: N passed, M total" / "N passed, M failed"
      const passMatch = text.match(/(\d+)\s*passed/i);
      const failMatch = text.match(/(\d+)\s*failed/i);
      if (passMatch || failMatch) {
        const p = passMatch ? parseInt(passMatch[1]!, 10) : 0;
        const f = failMatch ? parseInt(failMatch[1]!, 10) : 0;
        delta += p - f;
      }
    }
    return delta;
  }

  /**
   * 信息获取量（read/grep/glob/shell 返回内容的定量得分）
   *
   * 不再按布尔值计数——500 行文件与 5 行文件的信息量不同。
   * 每 INFO_GAINED_CHARS_PER_POINT 字符 = 1 分，单调用上限 INFO_GAINED_CAP_PER_CALL。
   */
  private countInfoGained(
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): number {
    const infoTools = new Set(['file_read', 'file_grep', 'file_glob', 'shell_bash']);
    let total = 0;
    for (const { call, result } of toolCalls) {
      if (infoTools.has(call.function.name) && result.ok && result.content) {
        total += Math.min(
          result.content.length,
          SCORE_WEIGHTS.INFO_GAINED_CAP_PER_CALL,
        );
      }
    }
    return Math.ceil(total / SCORE_WEIGHTS.INFO_GAINED_CHARS_PER_POINT);
  }

  /**
   * 工具成功数
   */
  private countToolSuccesses(turns: TurnSnapshot[]): number {
    let count = 0;
    for (const turn of turns) {
      for (const r of turn.results) {
        if (r.ok) count++;
      }
    }
    return count;
  }

  // --------------------------------------------------------------------------
  // 损失信号计算
  // --------------------------------------------------------------------------

  /**
   * 循环模式检测：同一签名连续 ≥3 次
   */
  private detectLoopPattern(turns: TurnSnapshot[]): boolean {
    // 收集所有签名
    const signatures: string[] = [];
    for (const turn of turns) {
      for (const tc of turn.toolCalls) {
        signatures.push(tc.signature);
      }
    }

    if (signatures.length < 3) return false;

    // 检查连续 3 个相同
    for (let i = 0; i <= signatures.length - 3; i++) {
      if (
        signatures[i] === signatures[i + 1] &&
        signatures[i] === signatures[i + 2]
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * 同一文件操作集中度——窗口内被操作最多的文件的出现次数。
   *
   * 改为频率统计（不再仅限于连续重复），能捕获 A→B→A→B 交替模式。
   * 返回窗口内任一文件的最大出现次数。
   */
  private countSameFileRepeat(
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): number {
    const counts = new Map<string, number>();
    for (const { call } of toolCalls) {
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        const path = typeof args.path === 'string' ? args.path : null;
        if (path) {
          counts.set(path, (counts.get(path) ?? 0) + 1);
        }
      } catch {
        // 参数非 JSON → 跳过
      }
    }
    if (counts.size === 0) return 0;
    return Math.max(0, ...counts.values());
  }

  /**
   * 空输出次数
   */
  private countEmptyOutputs(
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): number {
    return toolCalls.filter(
      ({ result }) => !result.ok && !result.content,
    ).length;
  }

  // --------------------------------------------------------------------------
  // 记录与恢复
  // --------------------------------------------------------------------------

  /**
   * 记录一轮的工具调用
   */
  private recordTurn(
    turn: number,
    toolCalls: { call: ToolCall; result: ToolResult }[],
  ): void {
    const snapshot: TurnSnapshot = {
      turn,
      toolCalls: toolCalls.map(({ call }) => ({
        name: call.function.name,
        signature: `${call.function.name}(${call.function.arguments})`,
      })),
      results: toolCalls.map(({ result }) => ({
        ok: result.ok,
        diffDelta: this.extractDiffDelta(result.diffSummary),
      })),
    };
    this.recentTurns.push(snapshot);

    // 只保留最近 windowSize * 2 轮
    if (this.recentTurns.length > this.windowSize * 2) {
      this.recentTurns.shift();
    }
  }

  /**
   * 从 diffSummary 中提取修改行数。
   *
   * 支持两种格式：
   *   1. SDB (Rust) 返回的 unified diff：按 hunk header @@ -a,b +c,d @@ 解析，
   *      并统计实际 +/- 行数。
   *   2. "+N/-M lines" 字符串格式（mock / 兼容）。
   */
  private extractDiffDelta(summary?: string): number {
    if (!summary) return 0;

    // 格式 1: 字符串 "+N/-M lines"（mock / 兼容）
    const compactMatch = summary.match(/\+(\d+)\/-(\d+)/);
    if (compactMatch) {
      return parseInt(compactMatch[1]!, 10) + parseInt(compactMatch[2]!, 10);
    }

    // 格式 2: unified diff（SDB Step 5 输出）
    // 解析 hunk header 统计行数，并补充统计超出 header 范围的实际行
    return this.countUnifiedDiffLines(summary);
  }

  /**
   * 统计 unified diff 中的实际变更行数。
   *
   * 两步策略:
   *   1. 解析 @@ -a,b +c,d @@ hunk header → 累积 b+d 作为基线
   *   2. 统计 diff 中实际的 + / - 行作为精确值
   *
   * 优先使用实际行统计（更真实），hunk header 作为保底。
   */
  private countUnifiedDiffLines(diff: string): number {
    // 统计实际 +/- 行（不含 ---, +++, @@ 元数据行）
    let added = 0;
    let removed = 0;
    let hunkBase = 0;

    for (const line of diff.split('\n')) {
      if (line.startsWith('@@')) {
        const hunkMatch = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (hunkMatch) {
          // b = 旧文件行数, d = 新文件行数
          const b = parseInt(hunkMatch[2] || '1', 10);
          const d = parseInt(hunkMatch[4] || '1', 10);
          hunkBase += b + d;
        }
        continue;
      }
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }

    // 优先用实际统计；如果为 0 则用 hunk header 估算
    const actual = added + removed;
    return actual > 0 ? actual : hunkBase;
  }

  // --------------------------------------------------------------------------
  // 停滞检测
  // --------------------------------------------------------------------------

  /**
   * ★ 三态停滞检测：
   *   - 连续 MAX_STALLED_TURNS 轮 score≤0 → warning
   *   - 连续 STALL_ABORT_THRESHOLD 轮 score≤0 → abort
   *
   *   注意：重复调用循环检测由 ReflectionEngine.intra() 负责（abortReason='loop_detected'），
   *   不与 progress 重复实现，避免两个系统分歧。
   */
  isStalled(): { stalled: boolean; level: 'warning' | 'abort' | 'none' } {
    const abortThreshold = SYSTEM.STALL_ABORT_THRESHOLD;
    if (this.currentStallCount >= abortThreshold) {
      return { stalled: true, level: 'abort' };
    }
    if (this.currentStallCount >= SYSTEM.MAX_STALLED_TURNS) {
      return { stalled: true, level: 'warning' };
    }
    return { stalled: false, level: 'none' };
  }

  /**
   * 重置（新会话）
   */
  reset(): void {
    this.recentTurns = [];
    this.currentStallCount = 0;
  }
}
