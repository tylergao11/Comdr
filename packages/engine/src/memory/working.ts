/**
 * memory/working.ts — 双窗口工作记忆（信用加权反馈）
 *
 * ★ 来源: FluxMem (2026) 三阶段 + Live-Evo (2026) 经验权重 + CAPF (2026) 信用衰减
 *
 * State Window (5 条 max): 记录 WHAT + 信用追踪
 *   - searches:    关联的搜索词（LLM 用 file_grep 搜过的 query）
 *   - successCount: 该文件上的操作成功次数
 *   - failCount:    该文件上的操作失败次数
 *   - credit = successCount*2 - failCount*3 + recency
 *
 * 淘汰: 信用最低的优先淘汰（误导记忆先出）
 * 注入: 信用 < 0 的不注入 enrichedQuery（风险感知——宁缺毋滥）
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { StateEntry, IntentEntry, SessionState, ToolCall, ToolResult } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

/**
 * 计算信用分——高信用保留、低信用淘汰、负信用不注入。
 *   credit = successCount * 2 - failCount * 3 + recency
 */
function computeCredit(entry: StateEntry, currentTurn: number): number {
  const recency = 1.0 - (currentTurn - entry.turn) / 10;
  return entry.successCount * 2 - entry.failCount * 3 + recency;
}
import { safeParseArgs } from '../utils.js';
import { deriveStableKey } from '../smart-truncate.js';

// ============================================================================
// §1 WorkingMemory
// ============================================================================

export class WorkingMemory {
  private stateMap: Map<string, StateEntry> = new Map();
  private intentMap: Map<string, IntentEntry> = new Map();

  private static readonly MAX_OPS_PER_FILE = 5;

  // --------------------------------------------------------------------------
  // State Window
  // --------------------------------------------------------------------------

  updateStateWindow(result: ToolResult, call: ToolCall, turn: number): void {
    const key = this.deriveKey(call);
    const verb = this.opVerb(call.function.name);
    const ok = result.ok ? '' : '❌';
    const op = `${ok}${verb}@${turn}`;

    const existing = this.stateMap.get(key);
    if (existing) {
      existing.text = this.mergeOps(existing.text, op);
      existing.turn = turn;
      if (result.ok) existing.successCount++;
      else existing.failCount++;
      this.stateMap.delete(key);
      this.stateMap.set(key, existing);
    } else {
      if (this.stateMap.size >= SYSTEM.MAX_STATE_WINDOW_SIZE) {
        this.evictLowestCredit();
      }
      this.stateMap.set(key, {
        key,
        text: op,
        turn,
        searches: [],
        successCount: result.ok ? 1 : 0,
        failCount: result.ok ? 0 : 1,
      });
    }
  }

  /**
   * ★ 记录搜索词——LLM 调 file_grep/file_search 时调用。
   *   搜索词关联到当前 State Window 中最近操作的文件。
   */
  recordSearch(query: string, targetFile?: string): void {
    if (!query.trim()) return;
    const entries = [...this.stateMap.values()];
    if (entries.length === 0) return;

    // 关联到目标文件或最近操作的文件
    if (targetFile) {
      const entry = this.stateMap.get(targetFile);
      if (entry && !entry.searches.includes(query)) {
        entry.searches.push(query);
        if (entry.searches.length > 5) entry.searches.shift();
      }
    } else {
      // 关联到最近操作的条目
      const last = entries[entries.length - 1]!;
      if (!last.searches.includes(query)) {
        last.searches.push(query);
        if (last.searches.length > 5) last.searches.shift();
      }
    }
  }

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

  /**
   * ★ 信用加权淘汰——信用最低的优先淘汰。
   *   负信用 = 误导记忆，正信用 = 成功路径。
   */
  private evictLowestCredit(): void {
    let worst: { key: string; credit: number } | null = null;
    const currentTurn = this.stateMap.size > 0
      ? [...this.stateMap.values()].reduce((max, e) => Math.max(max, e.turn), 0)
      : 0;

    for (const [key, entry] of this.stateMap) {
      const credit = computeCredit(entry, currentTurn);
      if (!worst || credit < worst.credit) {
        worst = { key, credit };
      }
    }
    if (worst) this.stateMap.delete(worst.key);
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
  // 读取 + 注入决策
  // --------------------------------------------------------------------------

  getStateWindow(): StateEntry[] {
    return [...this.stateMap.values()];
  }

  getIntentWindow(): IntentEntry[] {
    return [...this.intentMap.values()];
  }

  /**
   * ★ 风险感知注入——信用 < 0 的条目不注入 enrichedQuery。
   *   宁缺毋滥：误导记忆比无记忆更糟。
   */
  getActivePaths(currentTurn: number): string[] {
    return [...this.stateMap.values()]
      .filter((e) => computeCredit(e, currentTurn) >= 0)
      .map((e) => e.key);
  }

  /**
   * ★ 获取关联搜索词——用于 enrichedQuery 扩展。
   */
  getActiveSearches(currentTurn: number): string[] {
    const queries: string[] = [];
    for (const e of this.stateMap.values()) {
      if (computeCredit(e, currentTurn) >= 0) {
        queries.push(...e.searches);
      }
    }
    return [...new Set(queries)]; // 去重
  }

  restore(state: StateEntry[], intent: IntentEntry[]): void {
    this.stateMap = new Map(
      state.slice(-SYSTEM.MAX_STATE_WINDOW_SIZE).map((e) => [e.key, e]),
    );
    this.intentMap = new Map(
      intent.slice(-SYSTEM.MAX_INTENT_WINDOW_SIZE).map((e) => [e.key, e]),
    );
  }

  clear(): void {
    this.stateMap.clear();
    this.intentMap.clear();
  }
}
