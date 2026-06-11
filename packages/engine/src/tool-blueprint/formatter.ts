/**
 * formatter.ts — Blueprint 文本序列化
 *
 * 输入: ToolBlueprint（拓扑图）
 * 输出: LLM 友好的结构化文本（替换原 <tool_definitions> JSON dump）
 *
 * 格式设计:
 *   - 按 layer → domain 两级分组
 *   - 每工具 1 行、边为紧凑格式
 *   - 子 agent/MCP/skill 独立区块
 *   - Skeleton-first: ~80 行覆盖 30+ 工具
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolBlueprint, ToolBlueprintEdge, ToolBlueprintNode } from '@comdr/core';

// ============================================================================
// §1 formatBlueprint — 主序列化
// ============================================================================

/**
 * ★ 将蓝图层级序列化为 LLM 友好的结构化文本。
 * 输出格式极为紧凑——骨架优先，detail 走 tool_explore 按需展开。
 */
export function formatBlueprint(bp: ToolBlueprint): string {
  const lines: string[] = [];

  lines.push('<tool-blueprint>');

  // ---- Layers ----
  lines.push(formatLayer('Perceive', 'read/observe without side effects', bp, 'perceive'));
  lines.push('');
  lines.push(formatLayer('Operate', 'make changes to the world', bp, 'operate'));

  // Verify layer — 合并来自 perceive + operate 的验证能力
  const verifyLines = formatVerifyLayer(bp);
  if (verifyLines) {
    lines.push('');
    lines.push(verifyLines);
  }

  // ---- Composability ----
  if (bp.edges.length > 0) {
    lines.push('');
    lines.push(formatComposability(bp));
  }

  // ---- Source blocks ----
  const sources = groupBySource(bp.nodes);
  if (sources.length > 0) {
    lines.push('');
    for (const src of sources) {
      lines.push(formatSourceBlock(src));
    }
  }

  // ---- Hint ----
  lines.push('');
  lines.push('Use tool_explore(name) for: full parameters, all edges, workflow hints for a single tool.');

  lines.push('</tool-blueprint>');
  return lines.join('\n');
}

// ============================================================================
// §2 层格式化
// ============================================================================

function formatLayer(
  label: string,
  subhead: string,
  bp: ToolBlueprint,
  layer: string,
): string {
  const nodes = bp.nodes.filter((n) => n.layer === layer);
  if (nodes.length === 0) return `## ${label} — (none)`;

  const lines: string[] = [];
  lines.push(`## ${label} — ${subhead} (${nodes.length} tools)`);

  const groups = groupByDomain(nodes);
  for (const [domain, domainNodes] of Object.entries(groups)) {
    const toolNames = domainNodes.map((n) => {
      const timeout = n.timeoutHint !== '~10s' ? ` ${n.timeoutHint}` : '';
      return `${n.name}${timeout}`;
    }).join(', ');
    lines.push(`  [${domain}] ${toolNames}`);
  }

  return lines.join('\n');
}

/**
 * Verify 层——列出有 verifies 边的工具（它们可以从 operate 后验证）
 */
function formatVerifyLayer(bp: ToolBlueprint): string {
  // 收集所有被标记为 verifies 的边
  const verifierEdges = bp.edges.filter((e) => e.type === 'verifies');
  // 也收集可以用于验证的 perceive 工具
  const verifyTools = new Set<string>();
  for (const e of verifierEdges) {
    verifyTools.add(e.from); // the verifier
  }

  if (verifyTools.size === 0) return '';

  const tools = [...verifyTools].map((name) => {
    const node = bp.nodes.find((n) => n.name === name);
    const verifiedBy = verifierEdges
      .filter((e) => e.from === name)
      .map((e) => `${e.from} → ${e.to}`);
    if (verifiedBy.length > 0 && node) {
      return `${name} (verify ${verifiedBy.map((v) => v.split(' → ')[1]).join(', ')})`;
    }
    return name;
  });

  return `## Verify — Confirm previous operations\n  ${tools.join(', ')}`;
}

// ============================================================================
// §3 可组合性
// ============================================================================

function formatComposability(bp: ToolBlueprint): string {
  const lines: string[] = [];
  lines.push('## Composability');

  // 去重 + 分组
  const seen = new Set<string>();
  const edgeLines: string[] = [];

  for (const e of bp.edges) {
    const key = `${e.from}→${e.to}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const desc = e.description ? ` (${e.description.slice(0, 60)})` : '';
    edgeLines.push(`  ${e.from} ${arrowFor(e.type)} ${e.to}${desc}`);
  }

  if (edgeLines.length === 0) {
    lines.push('  (none defined)');
  } else {
    lines.push(...edgeLines.slice(0, 30)); // Cap at 30 for readability
    if (edgeLines.length > 30) {
      lines.push(`  ... +${edgeLines.length - 30} more (use tool_explore to discover)`);
    }
  }

  return lines.join('\n');
}

function arrowFor(type: string): string {
  switch (type) {
    case 'consumes': return '→';
    case 'verifies': return '✓→';
    case 'depends_on': return '⥅';
    case 'conflicts_with': return '✗';
    case 'alternative': return '↔';
    default: return '→';
  }
}

// ============================================================================
// §4 来源区块
// ============================================================================

interface SourceGroup {
  label: string;
  nodes: ToolBlueprintNode[];
}

function groupBySource(nodes: ToolBlueprintNode[]): SourceGroup[] {
  const map = new Map<string, ToolBlueprintNode[]>();
  const order: string[] = [];

  for (const n of nodes) {
    const src = n.source ?? 'main';
    if (src === 'main') continue; // 主工具不额外展示
    if (!map.has(src)) {
      map.set(src, []);
      order.push(src);
    }
    map.get(src)!.push(n);
  }

  return order.map((label) => ({ label, nodes: map.get(label)! }));
}

function groupByDomain(nodes: ToolBlueprintNode[]): Record<string, ToolBlueprintNode[]> {
  const groups: Record<string, ToolBlueprintNode[]> = {};
  for (const n of nodes) {
    if (!groups[n.domain]) groups[n.domain] = [];
    groups[n.domain]!.push(n);
  }
  // 稳定排序：domain 名
  const sorted: Record<string, ToolBlueprintNode[]> = {};
  for (const k of Object.keys(groups).sort()) {
    sorted[k] = groups[k]!;
  }
  return sorted;
}

function formatSourceBlock(src: SourceGroup): string {
  const label = src.label.startsWith('mcp:') ? `MCP: ${src.label.slice(4)}` : src.label;
  const toolNames = src.nodes.map((n) => `${n.name} ${n.timeoutHint}`).join(', ');
  return `## ${label}\n  ${toolNames}`;
}
