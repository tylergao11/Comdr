/**
 * compiler.ts — Blueprint 编译器
 *
 * 输入: ToolDefinition[]（扁平工具列表）
 * 输出: ToolBlueprint（拓扑图）
 *
 * 流水线:
 *   classify → extract summary/params → build IO → lookup edges → assemble
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolBlueprint, ToolBlueprintNode } from '@comdr/core';
import { EMPTY_LAYER_COUNTS } from '@comdr/core';
import type { ToolDefinition } from '@comdr/core/types';
import {
  classifyTool,
  extractSummary,
  extractParamSummary,
  formatTimeoutHint,
} from './classifier.js';
import { EDGE_TABLE } from './edge-table.js';

// ============================================================================
// §1 compileBlueprint
// ============================================================================

/**
 * ★ 将扁平 ToolDefinition[] 编译为 Tool Blueprint 拓扑图。
 *
 * @param tools  从 skillsLoader + mcpClient + subAgentRegistry 收集的完整工具列表
 * @returns      编译后的拓扑图（缓存稳定——同输入同输出）
 */
export function compileBlueprint(tools: ToolDefinition[]): ToolBlueprint {
  // Step 1: 每个工具 → 蓝图节点
  const nodes = tools.map((tool) => compileNode(tool));

  // Step 2: 解析边——只保留两端节点都存在的边
  const nodeNames = new Set(nodes.map((n) => n.name));
  const edges = EDGE_TABLE.filter(
    (e) => nodeNames.has(e.from) && nodeNames.has(e.to),
  );

  // Step 3: 统计每层工具数
  const layerCounts = { ...EMPTY_LAYER_COUNTS };
  for (const node of nodes) {
    layerCounts[node.layer]++;
  }

  return {
    schema: 'comdr.tool-blueprint.v1',
    nodes,
    edges,
    layerCounts,
    totalTools: nodes.length,
  };
}

// ============================================================================
// §2 节点编译
// ============================================================================

function compileNode(tool: ToolDefinition): ToolBlueprintNode {
  const classification = classifyTool(tool.name);

  return {
    name: tool.name,
    summary: extractSummary(tool),
    layer: classification.layer,
    domain: classification.domain,
    effect: classification.effect,
    permission: tool.permission,
    timeoutHint: formatTimeoutHint(tool.timeoutMs),
    io: extractIO(tool),
    paramSummary: extractParamSummary(tool),
    source: inferSource(tool.name),
    isDrillable: true,
  };
}

// ============================================================================
// §3 辅助
// ============================================================================

/**
 * 提取工具的输入/输出描述
 */
function extractIO(tool: ToolDefinition): { input: string[]; output: string } {
  const req = tool.parameters?.required ?? [];
  const props = tool.parameters?.properties ?? {};
  const allKeys = Object.keys(props);
  // 输入 = 参数名列表（优先 required）
  const input = req.length > 0 ? req : allKeys.slice(0, 3);
  // 输出 = 根据工具 name 推断
  const output = inferOutput(tool.name);
  return { input, output };
}

function inferOutput(toolName: string): string {
  if (toolName.startsWith('file_read') || toolName.startsWith('file_ls')) return 'text content';
  if (toolName.startsWith('file_glob')) return 'file path list';
  if (toolName.startsWith('file_grep')) return 'file:line:content matches';
  if (toolName.startsWith('file_search')) return 'scored file list';
  if (toolName.startsWith('file_edit') || toolName.startsWith('file_write')) return 'diff summary';
  if (toolName.startsWith('file_delete')) return 'confirmation';
  if (toolName.startsWith('shell_bash')) return 'stdout text';
  if (toolName.startsWith('shell_test')) return 'test results (pass/fail)';
  if (toolName.startsWith('git_status')) return 'porcelain status lines';
  if (toolName.startsWith('git_diff')) return 'unified diff';
  if (toolName.startsWith('git_log')) return 'commit list';
  if (toolName.startsWith('git_')) return 'OK/ERR + output';
  if (toolName.startsWith('lsp_')) return 'structured results';
  if (toolName.startsWith('memory_recall') || toolName.startsWith('symbol_find')) return 'matched entries';
  if (toolName.startsWith('tool_')) return 'tool info text';
  if (toolName.startsWith('task_spawn')) return 'sub-agent result';
  if (toolName.includes('__')) return 'structured JSON';
  return 'structured output';
}

function inferSource(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 2 ? `mcp:${parts[1]}` : 'mcp';
  }
  if (toolName.startsWith('skill__')) return 'skill';
  if (toolName.startsWith('runtime__')) return 'skill (runtime)';
  if (toolName.startsWith('vscode_')) return 'vscode';
  // 子 agent 工具
  const idx = toolName.indexOf('__');
  if (idx > 0 && !toolName.startsWith('mcp__')) {
    return toolName.slice(0, idx);
  }
  return 'main';
}
