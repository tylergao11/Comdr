/**
 * classifier.ts — 静态分类表
 *
 * ★ 确定性查表：tool name → { layer, domain, effect }
 *
 * 设计原则:
 *   1. 纯静态——不依赖 LLM 推理、embedding 或启发式猜测
 *   2. 基于 name prefix 匹配——同名前缀映射到同一域
 *   3. 未匹配项返回默认分类——保证 robustness
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { BlueprintLayer, ToolDomain, ToolEffect } from '@comdr/core';
import type { ToolDefinition } from '@comdr/core/types';

// ============================================================================
// §1 分类结果类型
// ============================================================================

export interface ToolClassification {
  layer: BlueprintLayer;
  domain: ToolDomain;
  effect: ToolEffect;
}

// ============================================================================
// §2 默认分类（未匹配工具的回退）
// ============================================================================

const DEFAULT_CLASSIFICATION: ToolClassification = {
  layer: 'operate',
  domain: 'subagent',
  effect: 'network',
};

// ============================================================================
// §3 分类表
// ============================================================================

/** domain 前缀表——优先匹配最长前缀 */
const DOMAIN_PREFIXES: Array<[string, ToolDomain]> = [
  ['git_', 'git'],
  ['lsp_', 'lsp'],
  ['file_read', 'filesystem'],
  ['file_ls', 'filesystem'],
  ['file_glob', 'search'],
  ['file_grep', 'search'],
  ['file_search', 'search'],
  ['file_edit', 'edit'],
  ['file_write', 'edit'],
  ['file_delete', 'edit'],
  ['shell_bash', 'shell'],
  ['shell_test', 'shell'],
  ['memory_recall', 'memory'],
  ['symbol_find', 'memory'],
  ['tool_search', 'orchestration'],
  ['tool_explore', 'orchestration'],
  ['task_spawn', 'orchestration'],
  ['mcp__', 'mcp'],
  ['skill__', 'skill'],
  ['runtime__', 'skill'],
];

/** layer 精确表（无歧义的工具） */
const LAYER_TABLE: Readonly<Record<string, BlueprintLayer>> = {
  file_read: 'perceive',
  file_ls: 'perceive',
  file_glob: 'perceive',
  file_grep: 'perceive',
  file_search: 'perceive',
  tool_search: 'perceive',
  tool_explore: 'perceive',
  git_status: 'perceive',
  git_diff: 'perceive',
  git_log: 'perceive',
  lsp_symbols: 'perceive',
  lsp_diagnostics: 'perceive',
  lsp_structure: 'perceive',
  memory_recall: 'perceive',
  symbol_find: 'perceive',
  file_write: 'operate',
  file_edit: 'operate',
  file_delete: 'operate',
  shell_bash: 'operate',
  shell_test: 'operate',
  git_add: 'operate',
  git_commit: 'operate',
  git_revert: 'operate',
  task_spawn: 'operate',
};

/** effect 精确表 */
const EFFECT_TABLE: Readonly<Record<string, ToolEffect>> = {
  file_read: 'read',
  file_ls: 'read',
  file_glob: 'read',
  file_grep: 'read',
  file_search: 'read',
  tool_search: 'read',
  tool_explore: 'read',
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  lsp_symbols: 'lsp_query',
  lsp_diagnostics: 'lsp_query',
  lsp_structure: 'lsp_query',
  memory_recall: 'memory_query',
  symbol_find: 'memory_query',
  file_write: 'write',
  file_edit: 'write',
  file_delete: 'delete',
  shell_bash: 'execute',
  shell_test: 'execute',
  git_add: 'git_mutate',
  git_commit: 'git_mutate',
  git_revert: 'git_mutate',
  task_spawn: 'agent_spawn',
};

// ============================================================================
// §4 公共 API
// ============================================================================

/**
 * 按工具名分类——静态查表。
 *
 * @param toolName  完整工具名（含前缀，如 "mcp__comdr__generate"）
 * @returns { layer, domain, effect }
 */
export function classifyTool(toolName: string): ToolClassification {
  return {
    layer: classifyLayer(toolName),
    domain: classifyDomain(toolName),
    effect: classifyEffect(toolName),
  };
}

function classifyDomain(toolName: string): ToolDomain {
  // 1. 精确匹配优先
  if (DOMAIN_PREFIXES.some(([k]) => k === toolName)) {
    return DOMAIN_PREFIXES.find(([k]) => k === toolName)![1];
  }
  // 2. 前缀匹配（从长到短——DOMAIN_PREFIXES 已按此排列）
  for (const [prefix, domain] of DOMAIN_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return domain;
    }
  }
  return DEFAULT_CLASSIFICATION.domain;
}

function classifyLayer(toolName: string): BlueprintLayer {
  if (toolName in LAYER_TABLE) return LAYER_TABLE[toolName]!;
  // 前缀规则：mcp__* / skill__* → operate
  if (toolName.startsWith('mcp__')) return 'operate';
  if (toolName.startsWith('skill__')) return 'operate';
  if (toolName.startsWith('runtime__')) return 'operate';
  // 子 agent 工具：检查带前缀名（audit__scan → 无精确匹配，默认 operate）
  // 如果 toolName 包含 "__" 且不在精确表中 → 子 agent 工具，默认 operate
  if (toolName.includes('__') && !toolName.startsWith('vscode_')) return 'operate';
  // VS Code 工具多数是 read_only
  if (toolName.startsWith('vscode_')) return 'perceive';
  return DEFAULT_CLASSIFICATION.layer;
}

function classifyEffect(toolName: string): ToolEffect {
  if (toolName in EFFECT_TABLE) return EFFECT_TABLE[toolName]!;
  if (toolName.startsWith('mcp__')) return 'network';
  if (toolName.startsWith('skill__')) return 'execute';
  if (toolName.startsWith('runtime__')) return 'execute';
  if (toolName.includes('__')) return 'network';
  return DEFAULT_CLASSIFICATION.effect;
}

/**
 * 从 ToolDefinition 提取摘要——首句（截断到 80 字符）
 */
export function extractSummary(tool: ToolDefinition): string {
  const firstSentence = tool.description.split(/[.。!！?？\n]/)[0] ?? tool.description;
  if (firstSentence.length <= 80) return firstSentence;
  return firstSentence.slice(0, 77) + '...';
}

/**
 * 从 ToolDefinition 提取参数摘要
 */
export function extractParamSummary(tool: ToolDefinition): string {
  const props = tool.parameters?.properties;
  if (!props) return '';
  const keys = Object.keys(props);
  if (keys.length === 0) return '(none)';
  const req = new Set(tool.parameters?.required ?? []);
  return keys
    .slice(0, 4)
    .map((k) => (req.has(k) ? k : `[${k}]`))
    .join(', ') + (keys.length > 4 ? '...' : '');
}

/**
 * 超时值 → 人读提示
 */
export function formatTimeoutHint(ms: number): string {
  if (ms <= 5000) return '~5s';
  if (ms <= 10000) return '~10s';
  if (ms <= 15000) return '~15s';
  if (ms <= 20000) return '~20s';
  if (ms <= 60000) return '~60s';
  if (ms <= 120000) return '~120s';
  return '~300s';
}
