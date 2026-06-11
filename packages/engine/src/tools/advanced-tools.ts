/**
 * advanced-tools.ts — 5 个高层语义工具
 *
 * 所有工具复用已有基础设施——零新轮子。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolDefinition } from '@comdr/core/types';
import { TOOL_PERMISSION } from '@comdr/core';
import { createTool } from './tool-factory.js';
import { TOOL_EXPLORE_DEF } from '../tool-blueprint/index.js';

// ============================================================================
// §1 定义
// ============================================================================

/**
 * 1. tool_search — 工具发现
 * 复用: ToolRetriever.retrieve() + BM25Scorer
 * 用途: LLM 不知道用哪个工具时，用它自己查
 */
export const TOOL_SEARCH: ToolDefinition = createTool({
  name: 'tool_search',
  description:
    'Find the right tool for a task. Returns matching tools with their descriptions and parameters. ' +
    'Use this when you are unsure which tool to use for a specific action.',
  params: {
    query: {
      type: 'string',
      description: 'What you want to do, in natural language (e.g. "search for files containing login logic").',
      required: true,
    },
  },
  permission: 'read_only',
  timeoutMs: 5000,
});

/**
 * 2. file_search — BM25 语义搜索
 * 复用: retrieval.ts BM25Scorer + tokenize + contextualPrefix
 * 用途: 补 file_grep 的缺口——正则找已知的，语义找未知的
 */
export const FILE_SEARCH: ToolDefinition = createTool({
  name: 'file_search',
  description:
    'Semantic search across project files using BM25 ranked retrieval. ' +
    'Returns the most relevant code sections for a natural language query. ' +
    'Use this for exploratory search when you do not know exact symbols or patterns — ' +
    'e.g. "find authentication logic" or "where is error handling for API calls". ' +
    'For exact regex matching, use file_grep instead.',
  params: {
    query: {
      type: 'string',
      description: 'Natural language description of what to find.',
      required: true,
    },
    topK: {
      type: 'number',
      description: 'Maximum number of results to return (default: 5).',
      default: 5,
    },
  },
  permission: 'read_only',
  timeoutMs: 15000,
});

/**
 * 3. memory_recall — 查询历史
 * 复用: EpisodicMemory.retrieve() + BM25Scorer
 * 用途: mid-task 时 LLM 可以主动查"上次类似问题怎么修的"
 */
export const MEMORY_RECALL: ToolDefinition = createTool({
  name: 'memory_recall',
  description:
    'Search past session history for related tasks and their outcomes. ' +
    'Returns a ranked list of previous sessions with their goals, file modifications, ' +
    'decisions made, and results. Use this when you want to learn from past work on similar problems.',
  params: {
    query: {
      type: 'string',
      description: 'What to search for in past sessions (e.g. "auth.ts refactoring" or "test failures in login").',
      required: true,
    },
  },
  permission: 'read_only',
  timeoutMs: 10000,
});

/**
 * 4. symbol_find — 查符号定义位置
 * 复用: SemanticMemory.findDefinition() + getDependents()
 * 用途: Bootstrap 静态分析数据对外暴露——LLM 不需要 file_grep 找函数定义
 */
export const SYMBOL_FIND: ToolDefinition = createTool({
  name: 'symbol_find',
  description:
    'Find where a symbol (function, class, variable) is defined in the codebase, and who depends on it. ' +
    'Returns the definition location and a list of dependents. ' +
    'Much faster than grep when the project has been bootstrapped — uses pre-built static analysis data.',
  params: {
    name: {
      type: 'string',
      description: 'Symbol name to search for (e.g. "loginHandler", "AuthService").',
      required: true,
    },
  },
  permission: 'read_only',
  timeoutMs: 5000,
});

/**
 * 5. shell_test — 结构化测试执行
 * 复用: SDB test_feedback.rs → ToolResult.testFeedback
 * 用途: LLM 主动跑测试并拿到结构化 pass/fail，不需要解析 shell_bash 的文本
 */
export const SHELL_TEST: ToolDefinition = createTool({
  name: 'shell_test',
  description:
    'Run project tests and return structured pass/fail counts. ' +
    'Returns JSON with {passed, failed, output, testFile} — use the numbers directly for decisions. ' +
    'Auto-detects test runner (vitest/jest/mocha/pytest/cargo/go test). ' +
    'Use this instead of shell_bash when you need to verify code changes.',
  params: {
    path: {
      type: 'string',
      description: 'Optional: test file or directory to run. Default: entire project.',
    },
    filter: {
      type: 'string',
      description: 'Optional: test name pattern to filter (e.g. "login" to run only login-related tests).',
    },
  },
  permission: TOOL_PERMISSION.DESTRUCTIVE,
  timeoutMs: 120000,
});

/**
 * 6. task_spawn — 启动子 Agent 执行独立任务
 * 复用: Engine 实例（共享 LLM + tools + config）
 * 用途: orchestrate 模式下 LLM 可以派生子 Agent 做并行审查/搜索/测试
 */
export const TASK_SPAWN: ToolDefinition = createTool({
  name: 'task_spawn',
  description:
    'Spawn an independent sub-agent to execute a task and return a structured result. ' +
    'The sub-agent has its own isolated session — it cannot see the main conversation. ' +
    'Use this for: parallel code review, independent research, multi-perspective verification, ' +
    'or any task that benefits from a clean context. ' +
    'Run multiple task_spawn calls in sequence to fan out parallel work.',
  params: {
    prompt: {
      type: 'string',
      description: 'Complete task description for the sub-agent (e.g. "Review src/auth.ts for security vulnerabilities and return a JSON list of issues"). Be specific and self-contained.',
      required: true,
    },
    mode: {
      type: 'string',
      description: "Run mode: 'agent' (full tools, confirms destructive), 'plan' (read-only analysis). Default: 'plan'.",
    },
  },
  permission: TOOL_PERMISSION.REQUIRES_APPROVAL,
  timeoutMs: 300000,
});

// ============================================================================
// §2 批量导出
// ============================================================================

/**
 * 5a. repo_query — 依赖图查询
 * 复用: SemanticMemory.getDependents() + getDependencies() + getTopImported()
 * 用途: LLM 想知道"谁依赖这个文件"或"哪些文件是核心枢纽"时直接查图，不用 grep 盲搜
 */
export const REPO_QUERY: ToolDefinition = createTool({
  name: 'repo_query',
  description:
    'Query the project dependency graph. Actions: "hubs" (most-imported files), ' +
    '"dependents" (who imports a file), "dependencies" (what a file imports), "find" (where a symbol is defined). ' +
    'Use this to understand project structure without guessing — much faster than grepping blindly.',
  params: {
    action: {
      type: 'string',
      description: 'Query action: "hubs", "dependents", "dependencies", or "find".',
      required: true,
    },
    file: {
      type: 'string',
      description: 'File path for dependents/dependencies queries.',
    },
    symbol: {
      type: 'string',
      description: 'Symbol name for find action.',
    },
  },
  permission: 'read_only',
  timeoutMs: 5000,
});

/** 所有高级工具（8 个） */
export const ADVANCED_TOOLS: ToolDefinition[] = [
  TOOL_EXPLORE_DEF,
  TOOL_SEARCH,
  FILE_SEARCH,
  MEMORY_RECALL,
  SYMBOL_FIND,
  REPO_QUERY,
  SHELL_TEST,
  TASK_SPAWN,
];
