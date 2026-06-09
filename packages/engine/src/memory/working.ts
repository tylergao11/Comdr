/**
 * memory/working.ts — 双窗口工作记忆
 *
 * 来源：Comdr 原创 + Factory AI 结构化摘要的理念映射
 *
 * State Window (5 条 max):
 *   - 记录 WHAT changed：文件路径、操作类型、结果摘要
 *   - key 稳定（如 'edit:src/foo.ts'），同 key 覆盖 → 晋升到最近
 *   - ★ Map-based LRU: delete+set 实现 O(1) 查找/晋升/淘汰
 *
 * Intent Window (5 条 max):
 *   - 记录 WHY changed：为什么要做这个操作
 *   - key 关联 StateEntry.key
 *   - ★ 同 key 晋升，Map-based LRU（同 State Window）
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  StateEntry,
  IntentEntry,
  SessionState,
  ToolCall,
  ToolResult,
} from '@comdr/core/types';
import { SYSTEM, ERROR_CATEGORY } from '@comdr/core';
import { safeParseArgs } from '../utils.js';
import {
  deriveStableKey,
  summarizeToolOutput,
  extractIntent,
} from '../smart-truncate.js';

// ============================================================================
// §1 WorkingMemory 类
// ============================================================================

export class WorkingMemory {
  /** Map-based LRU — O(1) for lookup, promote, evict. 保持插入顺序 */
  private stateMap: Map<string, StateEntry> = new Map();
  private intentMap: Map<string, IntentEntry> = new Map();

  // --------------------------------------------------------------------------
  // State Window
  // --------------------------------------------------------------------------

  /**
   * State Window 更新规则:
   *   - 同 key 覆盖 + 晋升为最近（delete + set）
   *   - 超过 MAX 时，淘汰最旧的（Map 第一个 key）
   *   - O(1) 所有操作
   */
  updateStateWindow(result: ToolResult, call: ToolCall, turn: number): void {
    const key = this.deriveKey(call);
    const text = this.summarizeResult(result);

    const entry: StateEntry = { key, text, turn };

    // ★ Map delete + set = LRU 晋升到末尾
    if (this.stateMap.has(key)) {
      this.stateMap.delete(key);
    } else if (this.stateMap.size >= SYSTEM.MAX_STATE_WINDOW_SIZE) {
      // 淘汰最旧的（插入顺序的第一个 key）
      const oldest = this.stateMap.keys().next().value;
      if (oldest !== undefined) this.stateMap.delete(oldest);
    }

    this.stateMap.set(key, entry);
  }

  /**
   * 从 tool call 中派生稳定的 key。
   *
   * ★ 委托给 smart-truncate 的 deriveStableKey():
   *   - path-based: 完整路径（天然唯一）
   *   - cmd-based: 命令名 + 关键参数 + fnv1a hash（防碰撞）
   *   - fallback: fnv1a(toolName + sortedArgs) → 永远不碰撞
   */
  private deriveKey(call: ToolCall): string {
    return deriveStableKey(call);
  }

  /**
   * 将 ToolResult 智能压缩为一句话摘要。
   *
   * ★ 委托给 smart-truncate 的 summarizeToolOutput():
   *   提取错误/测试结果/有意义的摘要，而非盲取首行截断。
   */
  private summarizeResult(result: ToolResult): string {
    if (!result.ok) {
      return `❌ ${result.toolName}: ${result.errorCategory ?? ERROR_CATEGORY.EXECUTION_ERROR}`;
    }
    if (result.diffSummary) {
      return result.diffSummary;
    }
    return summarizeToolOutput(result.content, result.toolName, SYSTEM.WORKING_TEXT_MAX_LENGTH);
  }

  // --------------------------------------------------------------------------
  // Intent Window
  // --------------------------------------------------------------------------

  /**
   * Intent Window 更新规则:
   *   - key 关联 StateEntry.key
   *   - 记录 WHY：为什么要做这个操作
   *   - 从 planner 的 task 描述或 tool call 的上下文中提取
   */
  updateIntentWindow(
    call: ToolCall,
    result: ToolResult,
    session: SessionState,
  ): void {
    const key = this.deriveKey(call);
    const why = this.inferIntent(call, result, session);

    const entry: IntentEntry = { key, why, turn: session.turn };

    // ★ Map delete + set = LRU 晋升到末尾 (O(1))
    if (this.intentMap.has(key)) {
      this.intentMap.delete(key);
    } else if (this.intentMap.size >= SYSTEM.MAX_INTENT_WINDOW_SIZE) {
      const oldest = this.intentMap.keys().next().value;
      if (oldest !== undefined) this.intentMap.delete(oldest);
    }

    this.intentMap.set(key, entry);
  }

  /**
   * 从 tool call 和会话上下文中推断意图
   *
   * 降级策略:
   *   1. 从 session.currentInput 提取最近的动词短语
   *   2. 从 tool call name + path 构造
   *   3. fallback: 纯工具名
   */
  private inferIntent(call: ToolCall, result: ToolResult, session: SessionState): string {
    const args = safeParseArgs(call.function.arguments);
    const path = typeof args.path === 'string' ? args.path : undefined;

    // 策略 1: 从用户输入提取意图
    const userIntent = this.extractIntentFromInput(session.currentInput);
    let base = userIntent;

    // 策略 2: 从 tool call 构造
    if (!base && path) {
      const verb = this.toolVerb(call.function.name);
      base = `${verb}: ${path}`;
    }

    // 策略 3: fallback
    if (!base) {
      base = `${call.function.name}`;
    }

    // ★ 利用 ToolResult 添加成败前缀——让意图窗口反映实际完成状态
    if (!result.ok) {
      return `❌ ${base}`;
    }
    return base;
  }

  /**
   * 从用户输入中智能提取意图。
   *
   * ★ 委托给 smart-truncate 的 extractIntent():
   *   句子检测 → 动词-名词定位 → 词边界截断（三级降级）
   */
  private extractIntentFromInput(input: string): string | null {
    return extractIntent(input, SYSTEM.INTENT_EXTRACT_MAX_LENGTH);
  }

  /**
   * 工具名 → 动词映射
   */
  private toolVerb(toolName: string): string {
    const verbMap: Record<string, string> = {
      file_read: 'read',
      file_write: 'write',
      file_edit: 'edit',
      file_delete: 'delete',
      file_ls: 'list',
      file_glob: 'search',
      file_grep: 'search',
      shell_bash: 'run',
      shell_exec: 'run',
      git_status: 'status',
      git_diff: 'diff',
      git_log: 'log',
      git_add: 'stage',
      git_commit: 'commit',
      git_revert: 'revert',
      git_branch: 'branch',
      lsp_symbols: 'find symbols',
      lsp_diagnostics: 'check diagnostics',
      lsp_structure: 'analyze structure',
    };
    if (verbMap[toolName]) return verbMap[toolName];

    // ★ MCP 工具 fallback: 去除命名空间前缀，转为可读格式
    if (toolName.startsWith('mcp__')) {
      const clean = toolName.replace(/^mcp__/, '').replace(/__/g, ' → ');
      return `call ${clean}`;
    }

    // 通用 fallback: 将下划线替换为空格
    return toolName.replace(/_/g, ' ');
  }

  // --------------------------------------------------------------------------
  // 读取接口
  // --------------------------------------------------------------------------

  /**
   * 获取当前的 State Window 快照（插入顺序，最近在末尾）
   */
  getStateWindow(): StateEntry[] {
    return [...this.stateMap.values()];
  }

  /**
   * 获取当前的 Intent Window 快照（插入顺序，最近在末尾）
   */
  getIntentWindow(): IntentEntry[] {
    return [...this.intentMap.values()];
  }

  /**
   * 从 SessionState 恢复双窗口
   *
   * ★ 确保恢复到 MAX_*_WINDOW_SIZE 以内：
   *   如果持久化的窗口数据超过限制（异常场景），
   *   只保留最近的部分——避免下一次 update 时的不一致。
   */
  restore(state: StateEntry[], intent: IntentEntry[]): void {
    this.stateMap = new Map(
      state
        .slice(-SYSTEM.MAX_STATE_WINDOW_SIZE)
        .map((e) => [e.key, e]),
    );
    this.intentMap = new Map(
      intent
        .slice(-SYSTEM.MAX_INTENT_WINDOW_SIZE)
        .map((e) => [e.key, e]),
    );
  }

  /**
   * 清空（新会话）
   */
  clear(): void {
    this.stateMap.clear();
    this.intentMap.clear();
  }
}
