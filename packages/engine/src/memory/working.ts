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
  ImportanceLevel,
} from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';
import { safeParseArgs } from '../utils.js';
import {
  deriveStableKey,
  extractIntent,
} from '../smart-truncate.js';

// ============================================================================
// §0 重要性评分
// ============================================================================

/**
 * 从 ToolCall + ToolResult 计算操作的重要性级别。
 *
 * 规则:
 *   - diffChanges > CRITICAL_THRESHOLD → critical
 *   - diffChanges > HIGH_THRESHOLD   → high
 *   - 核心文件扩展名 (.ts/.rs/.toml)  → +1 level
 *   - 纯读操作 → 最高 medium
 *   - 失败操作 → low（但保留最近 1 条用于诊断）
 *   - 默认 → medium
 */
function scoreImportance(
  call: ToolCall,
  result: ToolResult,
): ImportanceLevel {
  // 失败操作 → low
  if (!result.ok) return 'low';

  const toolName = call.function.name;
  const isWrite = ['file_write', 'file_edit', 'file_delete'].includes(toolName);
  const isRead = ['file_read', 'file_grep', 'file_glob', 'file_ls',
    'git_status', 'git_diff', 'git_log', 'lsp_symbols',
    'lsp_diagnostics', 'lsp_structure'].includes(toolName);

  // 计算 diff 变更量
  // ★ 优先解析 "+N/-M" 格式，避免把文件数、行号等非变更数字错误求和
  let diffChanges = 0;
  if (result.diffSummary) {
    const compact = result.diffSummary.match(/\+(\d+)\/-(\d+)/);
    if (compact) {
      diffChanges = parseInt(compact[1]!, 10) + parseInt(compact[2]!, 10);
    } else {
      // fallback: 统计 unified diff 中的实际 +/- 行
      let added = 0;
      let removed = 0;
      for (const line of result.diffSummary.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      diffChanges = added + removed;
    }
  }

  let level: ImportanceLevel = 'medium';

  // diff 阈值
  if (diffChanges > SYSTEM.IMPORTANCE_DIFF_CRITICAL_THRESHOLD) {
    level = 'critical';
  } else if (diffChanges > SYSTEM.IMPORTANCE_DIFF_HIGH_THRESHOLD) {
    level = 'high';
  } else if (isWrite && diffChanges > 0) {
    level = 'high'; // 任何有实质变更的写操作
  }

  // 纯读操作 → 不超过 medium
  if (isRead && level !== 'critical') {
    level = level === 'high' ? 'medium' : level;
  }

  // 核心文件扩展名 → +1 level
  if (result.diffSummary || isWrite) {
    const args = safeParseArgs(call.function.arguments);
    const path = typeof args.path === 'string' ? args.path : '';
    const ext = path.slice(path.lastIndexOf('.'));
    if (ext && SYSTEM.IMPORTANCE_CORE_EXTENSIONS.includes(ext)) {
      if (level === 'medium') level = 'high';
      else if (level === 'high') level = 'critical';
    }
  }

  return level;
}

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

  /** 单文件最多追踪的操作数，超出则压缩尾部 */
  private static readonly MAX_OPS_PER_FILE = 5;

  /**
   * ★ State Window — 按文件组织，同文件追加合并。
   *
   * key = 文件路径（同文件的不同工具操作合并到一条）
   * text = 操作链: "read@1 → edit❌@3 → edit✅@5 → test✅@7"
   *
   * 同类型连续操作合并（连续 edit 只保留最新 turn）。
   * 超过 MAX_OPS_PER_FILE 时尾部压缩为 "…(+N)"。
   */
  updateStateWindow(result: ToolResult, call: ToolCall, turn: number): void {
    const key = this.deriveKey(call);
    const verb = this.opVerb(call.function.name);
    const ok = result.ok ? '' : '❌';
    const op = `${ok}${verb}@${turn}`;
    const importance = scoreImportance(call, result);

    const existing = this.stateMap.get(key);
    if (existing) {
      existing.text = this.mergeOps(existing.text, op);
      existing.turn = turn;
      existing.importance = importance;
      // LRU 晋升到末尾
      this.stateMap.delete(key);
      this.stateMap.set(key, existing);
    } else {
      if (this.stateMap.size >= SYSTEM.MAX_STATE_WINDOW_SIZE) {
        this.evictLowestScore();
      }
      this.stateMap.set(key, { key, text: op, turn, importance });
    }
  }

  private evictLowestScore(): void {
    const worst = this.findWorstScoredEntry(this.stateMap);
    if (worst !== null) this.stateMap.delete(worst);
  }

  /** 追加合并操作链。同类型连续操作替换最后一个，超出上限压缩尾部。 */
  private mergeOps(existing: string, newOp: string): string {
    const parts = existing.split(' → ');
    if (parts.length > 0) {
      const last = parts[parts.length - 1]!;
      const lastVerb = last.replace(/^❌/, '').replace(/@\d+/, '').trim();
      const newVerb = newOp.replace(/^❌/, '').replace(/@\d+/, '').trim();
      if (lastVerb === newVerb) {
        parts[parts.length - 1] = newOp;
        return parts.join(' → ');
      }
    }
    parts.push(newOp);
    if (parts.length > WorkingMemory.MAX_OPS_PER_FILE) {
      const shown = parts.slice(-WorkingMemory.MAX_OPS_PER_FILE);
      const skipped = parts.length - WorkingMemory.MAX_OPS_PER_FILE;
      return shown.join(' → ') + `…(+${skipped})`;
    }
    return parts.join(' → ');
  }

  private deriveKey(call: ToolCall): string {
    return deriveStableKey(call);
  }

  private opVerb(toolName: string): string {
    const map: Record<string, string> = {
      file_read: 'read', file_write: 'write', file_edit: 'edit',
      file_delete: 'del', file_glob: 'glob', file_grep: 'grep',
      file_ls: 'ls', shell_bash: 'run', shell_test: 'test',
      git_diff: 'diff', git_status: 'st', git_log: 'log',
      git_add: 'add', git_commit: 'commit', git_revert: 'revert',
    };
    return map[toolName] ?? toolName.replace(/_/g, '');
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
    const importance = scoreImportance(call, result);

    const entry: IntentEntry = { key, why, turn: session.turn, importance };

    // ★ Map delete + set = LRU 晋升到末尾 (O(1))
    if (this.intentMap.has(key)) {
      this.intentMap.delete(key);
    } else if (this.intentMap.size >= SYSTEM.MAX_INTENT_WINDOW_SIZE) {
      // ★ 重要性加权淘汰
      this.evictLowestScoreIntent();
    }

    this.intentMap.set(key, entry);
  }

  /**
   * ★ Intent 窗口的重要性加权淘汰。
   */
  private evictLowestScoreIntent(): void {
    const worst = this.findWorstScoredEntry(this.intentMap);
    if (worst !== null) this.intentMap.delete(worst);
  }

  /**
   * ★ 通用加权淘汰——扫描 map 找到 score 最低的 key。
   *
   * 对 StateEntry 和 IntentEntry 均可使用（两者均有可选的 importance 字段）。
   * scan O(n), n ≤ MAX_WINDOW_SIZE → 可忽略。
   *
   * ★ Tie-breaking: 同分时优先淘汰旧 entry（age = total - posNormalized），
   *   而非按迭代顺序取第一个。避免"最新低重要性"被误淘汰而"最旧高重要性"被保留。
   */
  private findWorstScoredEntry(
    map: Map<string, StateEntry | IntentEntry>,
  ): string | null {
    const entries = [...map.entries()];
    if (entries.length === 0) return null;

    const total = entries.length;
    let worstKey: string | null = null;
    let worstScore = Infinity;
    let worstAge = 0; // 同分平局时优先淘汰旧的

    const w = SYSTEM.IMPORTANCE_WEIGHTS;

    for (let i = 0; i < entries.length; i++) {
      // ★ 循环保证 0 <= i < entries.length → entries[i] 在 bounds 内
      const [, entry] = entries[i]!;
      const impWeight = w[entry.importance ?? 'medium'] ?? w.medium;
      const posNormalized = (i + 1) / total;
      // recencyWeight: position 1 (最旧) → ~0, position N (最新) → 1
      const recencyWeight = Math.pow(posNormalized, SYSTEM.IMPORTANCE_RECENCY_DECAY_EXPONENT);
      // 最低 30% 保证 importance 有保底——即使最旧也不会权重为 0
      const score = impWeight * (0.3 + 0.7 * recencyWeight);
      // age: 越大表示越旧（posNormalized 越小）
      const age = total - (i + 1);

      // score 更低 → 淘汰。同分时优先淘汰更旧的（age 更大的）
      if (score < worstScore || (score === worstScore && age > worstAge)) {
        worstScore = score;
        worstAge = age;
        worstKey = entries[i]![0];
      }
    }

    return worstKey;
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
