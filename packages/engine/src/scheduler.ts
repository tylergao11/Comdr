/**
 * scheduler.ts — 拓扑并行工具执行调度器
 *
 * 来源: GraphBit (2026) — DAG-based engine orchestration.
 *       AsyncFC (2026) — dependency-aware inter-function parallelism.
 *       HyperEyes (2026) — "search wider rather than longer".
 *
 * 算法: Kahn BFS 分层 — 层内并行, 层间串行.
 *
 * 依赖规则:
 *   1. 共享文件路径 + 至少一个是写操作 → 串行
 *   2. 不共享路径 → 无条件并行
 *   3. 只读操作对任何路径都无依赖 → 无条件并行
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolCall } from '@comdr/core/types';

// ============================================================================
// §1 类型
// ============================================================================

/** 调度任务 */
interface Task {
  call: ToolCall;
  paths: string[];
  isWrite: boolean;
}

/** 调度结果: 按层分组的待执行调用 */
export type Schedule = ToolCall[][];

// ============================================================================
// §2 公开接口
// ============================================================================

/**
 * 对一组 tool calls 做拓扑排序，返回分层执行计划。
 *
 * @param calls  LLM 返回的 tool_calls（保持原始顺序）
 * @returns      分层结果: 层内可并行, 层间必须串行
 */
export function scheduleParallel(calls: ToolCall[]): Schedule {
  if (calls.length <= 1) return [calls];

  const n = calls.length;
  // 1. 提取每个调用的路径和类型
  const tasks: Task[] = calls.map((call) => extractTask(call));

  // 2. 建图: adj[u] = [v...]  u完成后v才能开始
  const adj: number[][] = Array.from({ length: n }, () => []);
  const indeg: number[] = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      // j.i 顺序: 只有当 task[j] 和 task[i] 冲突时, i 才等 j
      // 冲突 = 路径有交集 + 至少一个写操作
      if (conflict(tasks[j]!, tasks[i]!)) {
        adj[j]!.push(i);
        indeg[i]!++;
      }
    }
  }

  // 3. Kahn BFS 分层: 入度=0 的入队, 每队一层
  let frontier: number[] = [];
  for (let k = 0; k < n; k++) {
    if (indeg[k] === 0) frontier.push(k);
  }

  const layers: ToolCall[][] = [];

  while (frontier.length > 0) {
    // 当前层: 所有入度=0 的节点 → 可并行执行
    layers.push(frontier.map((i) => calls[i]!));

    const next: number[] = [];
    for (const u of frontier) {
      for (const v of adj[u]!) {
        indeg[v]!--;
        if (indeg[v] === 0) next.push(v);
      }
    }
    frontier = next;
  }

  return layers;
}

// ============================================================================
// §3 内部辅助
// ============================================================================

/**
 * 从 tool call 提取操作路径和类型。
 *
 * 路径来源:
 *   - path-based tools (file_read/write/edit/delete/glob/ls): 取 args.path
 *   - grep/glob: 取 args.path 作为搜索目录
 *   - shell_bash: 解析命令中的文件路径
 *   - git_*: 取 project root (互斥标记)
 */
function extractTask(call: ToolCall): Task {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    // 非 JSON → 保守处理: 标记为写操作
  }

  const name = call.function.name;
  const path = typeof args.path === 'string' ? args.path : undefined;
  const paths: string[] = [];

  if (path) {
    paths.push(normalizePath(path));
  }

  // shell 命令 → 尝试提取文件路径（保守: 标记为互斥）
  if (name === 'shell_bash' && typeof args.command === 'string') {
    const cmd = args.command as string;
    const matches = cmd.match(/(?:\/|\.\/|\.\.\/)[^\s]+/g);
    if (matches) {
      for (const m of matches) paths.push(normalizePath(m));
    } else {
      // 无法提取路径 → 标记为写操作（最安全）
      paths.push('__shell__');
    }
  }

  // git 操作 → 无文件路径 → 不冲突
  // (git_diff/status/log 都是只读, git_add/commit/revert 有写但无路径交集)

  const isWrite = !READ_ONLY_TOOLS.has(name);

  return { call, paths, isWrite };
}

/** 只读工具集合 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'file_read', 'file_grep', 'file_glob', 'file_ls',
  'git_diff', 'git_status', 'git_log',
  'tool_search', 'file_search', 'memory_recall', 'symbol_find',
  'lsp_symbols', 'lsp_diagnostics', 'lsp_structure',
]);

/**
 * 判断两个 task 是否冲突（需串行）。
 * 冲突条件: paths 交集非空, 且至少一个是写操作。
 */
function conflict(a: Task, b: Task): boolean {
  if (!a.isWrite && !b.isWrite) return false; // 两个都是读 → 无冲突

  const setA = new Set(a.paths);
  for (const p of b.paths) {
    if (setA.has(p)) return true;
  }

  // __shell__ 标记 → 保守串行
  if (a.paths.includes('__shell__') || b.paths.includes('__shell__')) return true;

  return false;
}

/**
 * 规范化路径: 去斜杠、去相对前缀、统一大小写。
 */
function normalizePath(p: string): string {
  // 去掉 ? 参数
  const clean = p.split('?')[0]!;
  // 统一斜杠
  let normalized = clean.replace(/\\/g, '/');
  // 去掉末尾斜杠
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // 转换为绝对路径形式
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}
