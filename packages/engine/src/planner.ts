/**
 * planner.ts — 任务路由
 *
 * ★ 6 模式路由：关键词匹配 → 输入长度推测 → 默认 orchestrate。
 *   工具选择由 ToolRetriever（TF-IDF）根据用户输入语义匹配，替代固定 toolPrefixes。
 *
 * replan() 在停滞时自动升级 thinking effort: high → max。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  Route,
  ProgressSignal,
  ToolDefinition,
  TaskType,
} from '@comdr/core/types';
import {
  ALL_TOOLS_SENTINEL,
  SYSTEM,
  TASK_TYPE,
  THINKING_TYPE,
  THINKING_EFFORT,
} from '@comdr/core';
import type { ToolRetriever } from './tool-retriever.js';

// ============================================================================
// §1 关键词模式表
// ============================================================================

interface ModeRule {
  taskType: typeof TASK_TYPE[keyof typeof TASK_TYPE];
  thinking: { type: 'enabled'; effort: 'high' | 'max' } | { type: 'disabled' };
  triggers: string[];
  /** TF-IDF 检索 top-K。orchestrate=-1 表示全量 */
  topK: number;
}

const MODE_RULES: ModeRule[] = [
  {
    taskType: TASK_TYPE.QUERY,
    thinking: { type: THINKING_TYPE.DISABLED },
    triggers: [
      '解释', '查找', '搜索', '找', '列出', '列表', '显示', '查看',
      'search', 'find', 'list', 'show', 'read',
      'diff', 'status', '是什么', '什么是', '怎么', '如何', '为什么',
      'grep', 'glob', 'ls', 'cat',
      'what ', 'how ', 'why ', 'when ', 'who ', 'which ', 'explain',
      'git log', '日志',
    ],
    topK: 5,
  },
  {
    taskType: TASK_TYPE.ARCHITECT,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
    triggers: [
      '设计', '分析', '评估', '架构', '方案', '规划',
      'architecture', 'design', 'plan', 'evaluate', 'assess',
    ],
    topK: 7, // ★ ARCHITECT 需理解更多工具上下文，比 QUERY(5) 多
  },
  {
    taskType: TASK_TYPE.REFACTOR,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
    triggers: [
      '重构', '重写', '拆分', '合并', '移动', '提取',
      'refactor', 'rewrite', 'rename across', 'rename all', 'move',
      'split', 'merge', 'extract', 'restructure',
    ],
    topK: 7,
  },
  {
    taskType: TASK_TYPE.GENERATE,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
    triggers: [
      '创建', '新建', '生成', '初始化', '脚手架',
      'create', 'generate', 'scaffold', 'init', 'new file', 'new project',
    ],
    topK: 5,
  },
  {
    taskType: TASK_TYPE.EDIT,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
    triggers: [
      '修改', '改', '修复', '添加', '删除', '更新', '替换',
      'change', 'fix', 'update', 'add', 'remove', 'delete',
      'rename', 'replace', 'edit', 'patch',
    ],
    topK: 7,
  },
];

// ============================================================================
// §2 TaskPlanner 类
// ============================================================================

export class TaskPlanner {
  private retriever: ToolRetriever | null = null;

  /** 注入工具检索器——Engine 构造时调用 */
  setRetriever(retriever: ToolRetriever): void {
    this.retriever = retriever;
  }

  /** ★ 增量添加工具到检索器（MCP 工具连接后调用） */
  addToolsToRetriever(tools: ToolDefinition[]): void {
    this.retriever?.addTools(tools);
  }

  /**
   * ★ 6 模式路由：关键词匹配 → 输入长度推测 → 默认 orchestrate。
   *   工具选择通过 TF-IDF 检索，按输入语义匹配。
   */
  route(input: string, availableTools: ToolDefinition[]): Route {
    const lower = input.toLowerCase().trim();

    // ── 策略 1: 关键词匹配 ──
    for (const rule of MODE_RULES) {
      for (const trigger of rule.triggers) {
        if (lower.includes(trigger)) {
          return this.makeRoute(input, rule, availableTools);
        }
      }
    }

    // ── 策略 2: 短输入（≤20 字符且不含破坏性动词）→ query ──
    if (lower.length <= 20) {
      const destructive = ['修改', '改', '创建', '新建', '删除', '写',
        '初始化', '生成', '构建', '安装', '添加', '重构',
        'change', 'fix', 'create', 'delete', 'write', 'edit', 'remove',
        'init', 'generate', 'scaffold', 'build', 'install', 'add', 'refactor'];
      const hasDestructive = destructive.some((w) => lower.includes(w));
      if (!hasDestructive) {
        return this.makeRoute(input, MODE_RULES[0]!, availableTools);
      }
    }

    // ── 策略 3: 默认 orchestrate（全部工具 + thinking=high） ──
    return {
      taskType: TASK_TYPE.ORCHESTRATE,
      thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
      allowedTools: [ALL_TOOLS_SENTINEL],
    };
  }

  /**
   * 构建 Route：taskType + thinking 由规则决定，工具由 TF-IDF 检索决定
   */
  private makeRoute(
    input: string,
    rule: ModeRule,
    availableTools: ToolDefinition[],
  ): Route {
    let allowed: string[];

    if (this.retriever) {
      // ★ TF-IDF 检索 top-K
      allowed = this.retriever.retrieve(input, rule.topK);
    } else {
      // 退化：retriever 未初始化（比如测试环境），全量
      allowed = availableTools.map((t) => t.name);
    }

    if (allowed.length === 0) {
      allowed = [ALL_TOOLS_SENTINEL];
    }

    return {
      taskType: rule.taskType,
      thinking: rule.thinking,
      allowedTools: allowed,
    };
  }

  /**
   * ★ classify — 仅返回 taskType（不执行完整路由）
   *
   * 复用 route() 的匹配逻辑，但只提取 taskType。
   * 用于需要快速判断任务类型但不需要完整 Route 的场景。
   */
  classify(input: string): TaskType {
    const lower = input.toLowerCase().trim();

    for (const rule of MODE_RULES) {
      for (const trigger of rule.triggers) {
        if (lower.includes(trigger)) {
          return rule.taskType;
        }
      }
    }

    // ★ 默认 edit（而非 orchestrate）——偏保守：
    //   classify() 用于快速判断，调用方通常需要的是"聚焦的工具子集"，
    //   而非"全量工具"的 orchestrate。EDIT 的 topK=7 提供了足够覆盖范围，
    //   但不会像 orchestrate（全量）那样让 LLM 面临过多选择。
    //   如果默认值不够，调用方可以手动指定 taskType。
    return TASK_TYPE.EDIT;
  }

  /**
   * 动态重规划：连续停滞时升级 thinking effort 到 max
   *
   * @returns 新的 Route（需要重规划时），null（不需要重规划时）
   */
  replan(
    currentRoute: Route,
    signal: ProgressSignal,
  ): Route | null {
    if (signal.stallCount >= SYSTEM.MAX_STALLED_TURNS || signal.loopPattern) {
      return {
        ...currentRoute,
        thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
      };
    }

    return null;
  }
}
