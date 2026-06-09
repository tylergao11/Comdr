/**
 * memory/semantic.ts — 语义记忆
 *
 * 来源：SWE-agent ACI 设计 + tree-sitter AST
 *
 * 四张关系图（当前骨架——产品级实现需要 tree-sitter 集成）:
 *   1. Semantic Graph  — 符号定义/引用关系 (tree-sitter AST)
 *   2. Temporal Graph  — 文件/符号的修改时间线
 *   3. Causal Graph    — 修改→测试失败的因果关系
 *   4. Entity Graph    — 类/函数/模块的依赖关系
 *
 * 当前阶段：提供增删查接口骨架，供 loop.ts 集成。
 * 后续 Phase 4 完善时接入 tree-sitter + SQLite。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolResult, ToolCall } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';
import { safeParseArgs } from '../utils.js';
import { summarizeToolOutput } from '../smart-truncate.js';

// ============================================================================
// §1 图节点/边类型
// ============================================================================

interface SemanticNode {
  id: string;
  type: 'file' | 'function' | 'class' | 'module' | 'variable';
  name: string;
  path: string;
  /** 定义位置（文件:行号） */
  location?: string;
}

interface SemanticEdge {
  from: string;
  to: string;
  type: 'defines' | 'imports' | 'calls' | 'modifies' | 'depends_on';
}

interface TemporalEntry {
  filePath: string;
  symbol?: string;
  action: 'created' | 'modified' | 'deleted' | 'read';
  turn: number;
  timestamp: string;
}

interface CausalLink {
  cause: string; // 修改描述
  effect: string; // 影响描述（如 "3/12 tests failed"）
  turn: number;
  confidence: number; // 0-1
}

// ============================================================================
// §2 SemanticMemory 类
// ============================================================================

export class SemanticMemory {
  // 四张图
  private semanticGraph: {
    nodes: Map<string, SemanticNode>;
    edges: SemanticEdge[];
  };
  private temporalGraph: TemporalEntry[];
  private causalGraph: CausalLink[];
  private entityGraph: {
    nodes: Map<string, SemanticNode>;
    edges: SemanticEdge[];
  };

  constructor() {
    this.semanticGraph = { nodes: new Map(), edges: [] };
    this.temporalGraph = [];
    this.causalGraph = [];
    this.entityGraph = { nodes: new Map(), edges: [] };
  }

  // --------------------------------------------------------------------------
  // 增量更新——只重建受影响的文件
  // --------------------------------------------------------------------------

  /**
   * 记录文件操作（从工具执行结果中提取）
   */
  recordFileOperation(
    call: ToolCall,
    result: ToolResult,
    turn: number,
  ): void {
    const args = safeParseArgs(call.function.arguments);
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) return;

    const action = this.inferAction(call.function.name);

    // 1. 更新 Temporal Graph
    this.temporalGraph.push({
      filePath: path,
      action,
      turn,
      timestamp: new Date().toISOString(),
    });

    // 2. 更新 Semantic Graph（如果是 write/edit）
    if (action === 'created' || action === 'modified') {
      this.upsertNode(
        this.semanticGraph,
        `file:${path}`,
        'file',
        path,
        path,
      );
    }

    // 3. 检测因果关系
    if (result.errorCategory === 'test_failed') {
      // 找到最近一次修改同一文件的记录
      const lastMod = this.findLastModification(path, turn);
      if (lastMod) {
        this.causalGraph.push({
          cause: `modified ${path} (turn ${lastMod.turn})`,
          effect: summarizeToolOutput(result.content, 'test', SYSTEM.WORKING_TEXT_MAX_LENGTH),
          turn,
          confidence: 0.7,
        });
      }
    }
  }

  /**
   * 注册符号定义（tree-sitter 解析后调用）
   * TODO: Phase 4 接入 tree-sitter
   */
  registerSymbol(
    name: string,
    type: 'function' | 'class' | 'module' | 'variable',
    filePath: string,
    location?: string,
  ): void {
    const id = `${filePath}#${name}`;
    this.upsertNode(this.semanticGraph, id, type, name, filePath, location);
    this.upsertNode(this.entityGraph, id, type, name, filePath, location);

    // 自动建立 file → symbol 的 defines 边
    const fileId = `file:${filePath}`;
    if (this.entityGraph.nodes.has(fileId)) {
      this.addEdge(this.entityGraph, fileId, id, 'defines');
    }
  }

  /**
   * 注册符号引用（import/调用关系）
   * TODO: Phase 4 接入 tree-sitter
   */
  registerReference(
    fromName: string,
    fromFile: string,
    toName: string,
    toFile: string,
    refType: 'imports' | 'calls' | 'depends_on',
  ): void {
    const fromId = `${fromFile}#${fromName}`;
    const toId = `${toFile}#${toName}`;
    this.addEdge(this.entityGraph, fromId, toId, refType);
  }

  // --------------------------------------------------------------------------
  // 查询接口
  // --------------------------------------------------------------------------

  /**
   * 查询文件的时间线
   */
  getFileTimeline(filePath: string): TemporalEntry[] {
    return this.temporalGraph.filter((e) => e.filePath === filePath);
  }

  /**
   * 查询符号的定义位置
   * @phase4 预留——tree-sitter 解析填充节点后可用
   */
  findDefinition(name: string): SemanticNode | undefined {
    for (const [, node] of this.semanticGraph.nodes) {
      if (node.name === name && node.type !== 'file') {
        return node;
      }
    }
    return undefined;
  }

  /**
   * 查询文件的依赖关系（被谁 import/调用）
   * @phase4 预留——entity graph 填充边后可用
   */
  getDependents(filePath: string): string[] {
    const fileId = `file:${filePath}`;
    return this.entityGraph.edges
      .filter((e) => e.to === fileId)
      .map((e) => e.from);
  }

  /**
   * 最近修改的 K 个文件
   */
  getRecentFiles(k: number = SYSTEM.SEMANTIC_RECENT_FILES_K): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of [...this.temporalGraph].reverse()) {
      if (!seen.has(entry.filePath)) {
        seen.add(entry.filePath);
        result.push(entry.filePath);
        if (result.length >= k) break;
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  private upsertNode(
    graph: typeof this.semanticGraph,
    id: string,
    type: SemanticNode['type'],
    name: string,
    path: string,
    location?: string,
  ): void {
    graph.nodes.set(id, {
      id,
      type,
      name,
      path,
      location,
    });
  }

  private addEdge(
    graph: typeof this.semanticGraph,
    from: string,
    to: string,
    type: SemanticEdge['type'],
  ): void {
    // 避免重复边
    const exists = graph.edges.some(
      (e) => e.from === from && e.to === to && e.type === type,
    );
    if (!exists) {
      graph.edges.push({ from, to, type });
    }
  }

  private inferAction(
    toolName: string,
  ): 'created' | 'modified' | 'deleted' | 'read' {
    switch (toolName) {
      case 'file_write':
        return 'created';
      case 'file_edit':
        return 'modified';
      case 'file_delete':
        return 'deleted';
      default:
        return 'read';
    }
  }

  private findLastModification(
    filePath: string,
    beforeTurn: number,
  ): TemporalEntry | null {
    const entries = this.temporalGraph
      .filter(
        (e) =>
          e.filePath === filePath &&
          e.turn < beforeTurn &&
          (e.action === 'created' || e.action === 'modified'),
      )
      .sort((a, b) => b.turn - a.turn);

    return entries[0] ?? null;
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  /**
   * 清空所有图（新会话）
   */
  clear(): void {
    this.semanticGraph = { nodes: new Map(), edges: [] };
    this.temporalGraph = [];
    this.causalGraph = [];
    this.entityGraph = { nodes: new Map(), edges: [] };
  }
}

// ============================================================================
// §3 工厂函数
// ============================================================================

/**
 * 创建语义记忆实例
 */
export function createSemanticMemory(): SemanticMemory {
  return new SemanticMemory();
}
