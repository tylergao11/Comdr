/**
 * planner.ts — 任务路由
 *
 * ★ 6 模式路由：基于关键词 + 规则（不调 LLM，零延迟）。
 *
 *   query       → thinking=disabled, 工具白名单: 只读
 *   edit        → thinking=enabled:high, 工具白名单: file_read/write/edit + glob/grep + shell
 *   generate    → thinking=enabled:high, 工具白名单: file_write + glob + shell
 *   refactor    → thinking=enabled:max, 工具白名单: file_read/edit + glob/grep + shell + git
 *   architect   → thinking=enabled:max, 工具白名单: 只读 + lsp_*
 *   orchestrate → thinking=enabled:high, 全部工具（默认 fallback）
 *
 * replan() 在停滞时自动升级 thinking effort: high → max。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  Route,
  ProgressSignal,
  ToolDefinition,
} from '@comdr/core/types';
import {
  ALL_TOOLS_SENTINEL,
  SYSTEM,
  TASK_TYPE,
  THINKING_TYPE,
  THINKING_EFFORT,
} from '@comdr/core';

// ============================================================================
// §1 关键词模式表
// ============================================================================

interface ModeRule {
  taskType: typeof TASK_TYPE[keyof typeof TASK_TYPE];
  thinking: { type: 'enabled'; effort: 'high' | 'max' } | { type: 'disabled' };
  /** 中文 + 英文触发词（小写匹配） */
  triggers: string[];
  /** 工具名白名单 */
  toolPrefixes: string[];
}

const MODE_RULES: ModeRule[] = [
  {
    // ★ query 最先匹配——只读操作无需 thinking
    taskType: TASK_TYPE.QUERY,
    thinking: { type: THINKING_TYPE.DISABLED },
    triggers: [
      '解释', '查找', '搜索', '找', '列出', '列表', '显示', '查看',
      'search', 'find', 'list', 'show', 'read', 'log',
      'diff', 'status', '是什么', '什么是', '怎么', '如何',
      'grep', 'glob', 'ls', 'cat',
    ],
    toolPrefixes: ['file_read', 'file_grep', 'file_glob', 'file_ls',
      'git_diff', 'git_status', 'git_log', 'lsp_'],
  },
  {
    taskType: TASK_TYPE.ARCHITECT,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
    triggers: [
      '设计', '分析', '评估', '架构', '方案', '规划',
      'architecture', 'design', 'plan', 'evaluate', 'assess',
    ],
    toolPrefixes: ['file_read', 'file_grep', 'file_glob', 'file_ls',
      'git_diff', 'git_status', 'git_log', 'lsp_'],
  },
  {
    taskType: TASK_TYPE.REFACTOR,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.MAX },
    triggers: [
      '重构', '重写', '拆分', '合并', '移动', '提取',
      'refactor', 'rewrite', 'rename across', 'rename all', 'move',
      'split', 'merge', 'extract', 'restructure',
    ],
    toolPrefixes: ['file_read', 'file_edit', 'file_write',
      'file_grep', 'file_glob', 'shell_bash', 'git_'],
  },
  {
    taskType: TASK_TYPE.GENERATE,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
    triggers: [
      '创建', '新建', '生成', '初始化', '脚手架',
      'create', 'generate', 'scaffold', 'init', 'new file', 'new project',
    ],
    toolPrefixes: ['file_read', 'file_write', 'file_glob', 'shell_bash'],
  },
  {
    taskType: TASK_TYPE.EDIT,
    thinking: { type: THINKING_TYPE.ENABLED, effort: THINKING_EFFORT.HIGH },
    triggers: [
      '修改', '改', '修复', '添加', '删除', '更新', '替换',
      'change', 'fix', 'update', 'add', 'remove', 'delete',
      'rename', 'replace', 'edit', 'patch',
    ],
    toolPrefixes: ['file_read', 'file_write', 'file_edit',
      'file_grep', 'file_glob', 'shell_bash'],
  },
];

// ============================================================================
// §2 TaskPlanner 类
// ============================================================================

export class TaskPlanner {
  /**
   * ★ 6 模式路由：关键词匹配 → 输入长度推测 → 默认 orchestrate
   *
   * @param input          用户原始输入
   * @param availableTools 当前活跃的全部工具定义
   */
  route(input: string, availableTools: ToolDefinition[]): Route {
    const lower = input.toLowerCase().trim();

    // ── 策略 1: 关键词匹配 ──
    for (const rule of MODE_RULES) {
      for (const trigger of rule.triggers) {
        if (lower.includes(trigger)) {
          return this.makeRoute(rule, availableTools);
        }
      }
    }

    // ── 策略 2: 短输入（≤20 字符且不含破坏性动词）→ query ──
    if (lower.length <= 20) {
      const destructive = ['修改', '改', '创建', '新建', '删除', '写',
        'change', 'fix', 'create', 'delete', 'write', 'edit', 'remove'];
      const hasDestructive = destructive.some((w) => lower.includes(w));
      if (!hasDestructive) {
        return this.makeRoute(MODE_RULES[0]!, availableTools);
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
   * 根据规则构建 Route，将 toolPrefixes 匹配到实际工具名
   */
  private makeRoute(rule: ModeRule, availableTools: ToolDefinition[]): Route {
    const allowed = availableTools
      .filter((t) =>
        rule.toolPrefixes.some((prefix) => t.name.startsWith(prefix)),
      )
      .map((t) => t.name);

    // 如果白名单过滤后为空（比如 availableTools 还没加载），fallback 到 ALL
    if (allowed.length === 0) {
      return {
        taskType: rule.taskType,
        thinking: rule.thinking,
        allowedTools: [ALL_TOOLS_SENTINEL],
      };
    }

    return {
      taskType: rule.taskType,
      thinking: rule.thinking,
      allowedTools: allowed,
    };
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
