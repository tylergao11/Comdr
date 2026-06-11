/**
 * expander.ts — tool_explore 逻辑
 *
 * LLM 通过 tool_explore(name) 按需展开具体工具的完整详情。
 * 展开结果只作为工具返回值，不改变静态 blueprint → 前缀缓存不受影响。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  ToolBlueprint,
  ToolBlueprintExpansion,
  ToolBlueprintEdge,
} from '@comdr/core';
import type { ToolDefinition, JSONSchemaProperty } from '@comdr/core/types';
import { createTool } from '../tools/tool-factory.js';

// ============================================================================
// §1 tool_explore 工具定义
// ============================================================================

/**
 * ★ tool_explore — Blueprint 世界的 help() 命令。
 *
 * LLM 在不确定工具用法时调用它，获得完整参数、拓扑关系、替代方案和工作流提示。
 * 这只是工具定义——执行逻辑由 Engine.executeToolAsync 中的 isAdvancedTool 分支处理。
 */
export const TOOL_EXPLORE_DEF: ToolDefinition = createTool({
  name: 'tool_explore',
  description:
    'Explore any tool in the Blueprint world model. Returns full parameters, ' +
    'composability relationships (what it consumes, what verifies it, alternatives), ' +
    'and recommended workflow. Use this before operating a tool you are unfamiliar with, ' +
    'or when you need to understand how tools connect to each other.',
  params: {
    name: {
      type: 'string',
      description: 'Tool name to explore. Examples: "file_edit", "audit__scan", "tool_explore". '
        + 'Use the exact name from the blueprint.',
      required: true,
    },
  },
  permission: 'read_only',
  timeoutMs: 3000,
});

// ============================================================================
// §2 expandTool
// ============================================================================

/**
 * 展开单个工具——从原始 ToolDefinition[] + Blueprint 中提取完整详情。
 *
 * @param toolName  要展开的工具名
 * @param tools     原始 ToolDefinition[]（找完整参数）
 * @param blueprint 已编译的 Blueprint（找边关系 + workflow hints）
 */
export function expandTool(
  toolName: string,
  tools: ToolDefinition[],
  blueprint: ToolBlueprint,
): ToolBlueprintExpansion | null {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return null;

  const node = blueprint.nodes.find((n) => n.name === toolName);
  const allEdges = blueprint.edges;

  // 收集与此工具相关的边
  const incomingEdges: ToolBlueprintEdge[] = [];
  const outgoingEdges: ToolBlueprintEdge[] = [];
  const alternatives: string[] = [];

  for (const e of allEdges) {
    if (e.to === toolName) incomingEdges.push(e);
    if (e.from === toolName) {
      outgoingEdges.push(e);
      if (e.type === 'verifies' || e.type === 'consumes') {
        // These are outgoing to other tools
      }
    }
  }

  // 替代工具收集
  for (const e of allEdges) {
    if (e.type === 'alternative') {
      if (e.from === toolName && !alternatives.includes(e.to)) {
        alternatives.push(e.to);
      }
      if (e.to === toolName && !alternatives.includes(e.from)) {
        alternatives.push(e.from);
      }
    }
  }

  // 反查——作为验证方的边（其他工具→此工具 where this is the verifier）
  // 这已经收集在 outgoingEdges 中（from 是此工具，type 是 verifies）

  return {
    nodeName: toolName,
    fullDescription: tool.description,
    parameters: tool.parameters,
    incomingEdges,
    outgoingEdges,
    alternatives,
    workflowHints: buildWorkflowHints(toolName, node?.layer ?? 'operate'),
  };
}

// ============================================================================
// §3 formatExpansion
// ============================================================================

/**
 * ★ 将展开结果格式化为 LLM 友好的文本。
 * 格式类似 cocos-engine 的 retrieve(detail=full) 展开视图。
 */
export function formatExpansion(exp: ToolBlueprintExpansion): string {
  const lines: string[] = [];
  const src = inferSourceName(exp.nodeName);

  lines.push(`<tool-explore name="${exp.nodeName}">`);

  // Header
  lines.push('');
  lines.push(`[NODE] ${exp.nodeName}`);
  if (src) lines.push(`  Source: ${src}`);

  // Description
  lines.push('');
  lines.push(`  Description:`);
  // Wrap long descriptions
  for (const line of wrapText(exp.fullDescription, 100)) {
    lines.push(`    ${line}`);
  }

  // Parameters
  lines.push('');
  lines.push('  Parameters:');
  const props = exp.parameters?.properties ?? {};
  const req = new Set(exp.parameters?.required ?? []);
  if (Object.keys(props).length === 0) {
    lines.push('    (none)');
  } else {
    for (const [key, prop] of Object.entries(props)) {
      const required = req.has(key) ? ' (required)' : '';
      const defaultVal = prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : '';
      const typeStr = formatPropType(prop);
      lines.push(`    ${key}: ${typeStr}${required}${defaultVal} — ${prop.description ?? ''}`);
    }
  }

  // Relationships
  if (exp.incomingEdges.length > 0) {
    lines.push('');
    lines.push('  Consumed from:');
    for (const e of exp.incomingEdges) {
      lines.push(`    ← ${e.from} (${e.type}: ${e.description ?? ''})`);
    }
  }

  if (exp.outgoingEdges.length > 0) {
    lines.push('');
    lines.push('  Feeds into:');
    for (const e of exp.outgoingEdges) {
      lines.push(`    → ${e.to} (${e.type}: ${e.description ?? ''})`);
    }
  }

  if (exp.alternatives.length > 0) {
    lines.push('');
    lines.push('  Alternatives:');
    for (const a of exp.alternatives) {
      lines.push(`    ~ ${a}`);
    }
  }

  // Workflow
  if (exp.workflowHints.length > 0) {
    lines.push('');
    lines.push('  Workflow:');
    for (const hint of exp.workflowHints) {
      lines.push(`    ${hint}`);
    }
  }

  lines.push('');
  lines.push('</tool-explore>');
  return lines.join('\n');
}

// ============================================================================
// §4 辅助
// ============================================================================

function buildWorkflowHints(toolName: string, layer: string): string[] {
  const hints: string[] = [];

  if (toolName === 'file_edit') {
    hints.push('1. ALWAYS file_read the target file first to get the exact old_string');
    hints.push('2. Execute file_edit with precise match (including whitespace/indentation)');
    hints.push('3. Verify with file_read — confirm the diff matches your intent');
    hints.push('4. If editing code: follow with lsp_diagnostics to catch syntax errors');
    hints.push('5. If editing logic: follow with shell_test to verify nothing is broken');
  } else if (toolName === 'file_write') {
    hints.push('1. Check if file exists: file_read or file_ls first');
    hints.push('2. Write the content');
    hints.push('3. Verify with file_read — confirm content is correct');
  } else if (toolName === 'file_delete') {
    hints.push('1. Confirm the file exists: file_read or file_ls first');
    hints.push('2. Delete the file');
    hints.push('3. Verify with file_ls — confirm the file is gone');
  } else if (toolName === 'shell_bash') {
    hints.push('1. Prefer dedicated tools (file_read, file_grep, git_diff) over raw shell');
    hints.push('2. Use shell_bash when no dedicated tool exists for the task');
    hints.push('3. Quote paths with spaces');
    hints.push('4. Check exit code — non-zero = failure');
  } else if (toolName === 'git_commit') {
    hints.push('1. git_status to see what changed');
    hints.push('2. git_diff to review all changes');
    hints.push('3. git_add to stage the right files');
    hints.push('4. git_commit with a clear message');
  } else if (toolName.startsWith('git_')) {
    hints.push('1. Use git_status first to understand the current state');
    hints.push('2. Use git_diff before destructive git operations');
  } else if (layer === 'perceive') {
    hints.push('1. This is a read-only tool — no side effects');
    hints.push('2. Use its output to decide what to operate on next');
  } else if (layer === 'operate') {
    hints.push('1. This tool changes the world — read before you act');
    hints.push('2. Verify the result after execution');
  }

  return hints;
}

function formatPropType(prop: JSONSchemaProperty): string {
  const type = prop.type;
  if (type === 'array' && prop.items) {
    const itemType = prop.items.type;
    return `${itemType}[]`;
  }
  return type ?? 'string';
}

function inferSourceName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'MCP';
  if (toolName.startsWith('skill__')) return 'Skill';
  if (toolName.startsWith('runtime__')) return 'Skill (runtime)';
  if (toolName.startsWith('vscode_')) return 'VS Code Extension';
  const idx = toolName.indexOf('__');
  if (idx > 0 && !toolName.startsWith('mcp__')) return toolName.slice(0, idx);
  return '';
}

function wrapText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to break at space
    let breakAt = remaining.lastIndexOf(' ', maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  return lines;
}
