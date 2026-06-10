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

/**
 * 常见停用词——从候选词提取中排除。
 * 这些词在代码相关查询中无区分度。
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are',
  'was', 'not', 'but', 'all', 'can', 'has', 'had', 'been', 'were',
  'they', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'also', 'then', 'just', 'only', 'into', 'over', 'its', 'get', 'set',
  '使用', '怎么', '如何', '什么', '为什么', '一个', '这个', '那个',
]);

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
   * ★ Graph RAG: 从用户输入中检索相关代码实体。
   *
   * 算法（确定性图遍历，不走 embedding）:
   *   1. 从 input 提取候选词（路径段、驼峰/下划线命名单词）
   *   2. 在 Entity Graph + Semantic Graph 节点中做子串匹配
   *   3. BFS 一层找邻居节点（defines/imports/calls/depends_on 边）
   *   4. 查 Temporal Graph: 候选词匹配到的文件 → 最近修改记录
   *
   * @param input     用户输入
   * @param topK      返回最多 K 个实体
   * @param bfsDepth  BFS 邻居遍历深度（默认 2）
   * @returns         格式化的上下文文本（可直接注入 prompt）
   */
  retrieveRelevantEntities(
    input: string,
    topK: number = SYSTEM.SEMANTIC_ENTITY_RETRIEVAL_TOPK,
    bfsDepth: number = SYSTEM.SEMANTIC_ENTITY_BFS_DEPTH,
  ): string {
    const candidates = this.extractCandidates(input);
    if (candidates.length === 0) return '';

    // Step 1: 在 Semantic + Entity Graph 中匹配
    const matchedNodes: SemanticNode[] = [];
    const allNodes = [
      ...this.semanticGraph.nodes.values(),
      ...this.entityGraph.nodes.values(),
    ];
    const seen = new Set<string>();

    for (const node of allNodes) {
      if (seen.has(node.id)) continue;

      for (const cand of candidates) {
        if (
          node.name.toLowerCase().includes(cand) ||
          node.path.toLowerCase().includes(cand)
        ) {
          matchedNodes.push(node);
          seen.add(node.id);
          break;
        }
      }
    }

    // Step 2: BFS 找邻居（合并两个图的边）
    const allEdges = [
      ...this.semanticGraph.edges,
      ...this.entityGraph.edges,
    ];
    const neighborMap = new Map<string, string[]>(); // nodeId → neighbor descriptions

    for (const node of matchedNodes) {
      const neighbors: string[] = [];
      const visited = new Set<string>([node.id]);

      // BFS
      let frontier = [node.id];
      for (let depth = 0; depth < bfsDepth; depth++) {
        const nextFrontier: string[] = [];
        for (const fid of frontier) {
          for (const edge of allEdges) {
            let neighborId: string | null = null;
            let rel: string | null = null;

            if (edge.from === fid) {
              neighborId = edge.to;
              rel = edge.type;
            } else if (edge.to === fid) {
              neighborId = edge.from;
              rel = `inverse_${edge.type}`;
            }

            if (neighborId && !visited.has(neighborId)) {
              visited.add(neighborId);
              nextFrontier.push(neighborId);

              // 查找邻居节点名称
              const neighborNode =
                this.entityGraph.nodes.get(neighborId) ??
                this.semanticGraph.nodes.get(neighborId);
              const display = neighborNode
                ? `${neighborNode.name} (${neighborNode.type})`
                : neighborId;
              neighbors.push(`${display} [${rel}]`);
            }
          }
        }
        frontier = nextFrontier;
      }

      if (neighbors.length > 0) {
        neighborMap.set(node.id, neighbors);
      }
    }

    // Step 3: 查 Temporal Graph——候选词匹配到的文件
    const temporalMatches: string[] = [];
    const temporalFiles = new Set<string>();
    for (const entry of this.temporalGraph) {
      if (temporalFiles.has(entry.filePath)) continue;
      for (const cand of candidates) {
        if (entry.filePath.toLowerCase().includes(cand)) {
          temporalMatches.push(
            `${entry.action} ${entry.filePath} (turn ${entry.turn})`,
          );
          temporalFiles.add(entry.filePath);
          break;
        }
      }
    }

    // Step 4: 格式化输出
    return this.formatEntityContext(
      matchedNodes.slice(0, topK),
      neighborMap,
      temporalMatches.slice(0, topK),
    );
  }

  /**
   * 从用户输入提取候选词。
   *
   * 提取策略:
   *   - 路径段: 按 / 和 \ 分割
   *   - 驼峰命名: loop.ts → [loop, ts]
   *   - 下划线命名: test_feedback → [test, feedback]
   *   - 英文单词: 按非字母数字分割（排除过短的词和常见停用词）
   */
  private extractCandidates(input: string): string[] {
    const candidates: string[] = [];
    const lower = input.toLowerCase();

    // 路径段（按 / \ 分割）
    const pathSegments = lower.split(/[/\\]/);
    for (const seg of pathSegments) {
      const clean = seg.trim();
      if (clean.length >= 2) candidates.push(clean);
    }

    // 单词（按空格/标点分割）
    const words = lower.split(/[\s,.;:!?()\[\]{}"'`]+/);
    for (const w of words) {
      if (w.length >= 3 && !STOP_WORDS.has(w)) {
        candidates.push(w);
        // 驼峰/下划线拆分
        const parts = w.split(/[_-]/);
        for (const p of parts) {
          if (p.length >= 2) candidates.push(p);
        }
        // 驼峰拆分: testFeedback → [testfeedback, test, feedback]
        const camelParts = w.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
        for (const p of camelParts) {
          if (p.length >= 2) candidates.push(p);
        }
      }
    }

    // 去重
    return [...new Set(candidates)];
  }

  /**
   * ★ Phase 3: 格式化实体上下文为 Markdown 拓扑子图。
   *
   * 输出格式:
   *   ```
   *   ## Dependency Graph
   *   file.ts
   *   └── [defines] func() @ :42
   *       ├── [calls] Other.fn() → other.ts:10
   *       │   └── [depends_on] Cache → cache.ts
   *       └── [imported_by] app.ts → middleware/auth.ts
   *
   *   ## Temporal Context
   *   - modified file.ts (turn 3)
   *   ```
   *
   * 超过 15 个节点的子图 → 只展示 top 5 节点 + 统计摘要。
   */
  private formatEntityContext(
    nodes: SemanticNode[],
    neighborMap: Map<string, string[]>,
    temporalMatches: string[],
  ): string {
    const blocks: string[] = [];

    // ── Dependency Graph ──
    const MAX_NODES = SYSTEM.GRAPH_DISPLAY_MAX_NODES;
    if (nodes.length > MAX_NODES) {
      blocks.push('## Dependency Graph');
      blocks.push(`(${nodes.length} relevant entities — showing top ${Math.min(5, nodes.length)})`);
    } else if (nodes.length > 0) {
      blocks.push('## Dependency Graph');
    }

    for (const node of nodes.slice(0, MAX_NODES)) {
      const loc = node.location ? ` @ ${node.location}` : '';
      // 文件节点 → 作为根
      if (node.type === 'file') {
        blocks.push(`${node.path}`);
        this.appendNeighbors(blocks, neighborMap, node.id, 1);
      } else {
        blocks.push(`\`${node.name}\` (${node.type}) in ${node.path}${loc}`);
        this.appendNeighbors(blocks, neighborMap, node.id, 1);
      }
    }

    // ── Temporal Context ──
    if (temporalMatches.length > 0) {
      blocks.push('');
      blocks.push('## Temporal Context');
      for (const tm of temporalMatches.slice(0, SYSTEM.TIMELINE_DISPLAY_MAX_ITEMS)) {
        blocks.push(`- ${tm}`);
      }
    }

    return blocks.join('\n');
  }

  /**
   * 递归追加邻居节点（带缩进和树状标记）。
   * depth 控制递归深度，超过 2 层 → 仅标注 "(+N more)"。
   */
  private appendNeighbors(
    lines: string[],
    neighborMap: Map<string, string[]>,
    nodeId: string,
    depth: number,
  ): void {
    const neighbors = neighborMap.get(nodeId);
    if (!neighbors || neighbors.length === 0) return;

    const MAX_PER_LEVEL = SYSTEM.GRAPH_DISPLAY_NEIGHBORS_PER_LEVEL;
    const shown = neighbors.slice(0, MAX_PER_LEVEL);
    const prefix = depth === 1 ? '  ' : '      ';

    for (let i = 0; i < shown.length; i++) {
      const isLast = i === shown.length - 1 && neighbors.length <= MAX_PER_LEVEL;
      const branch = isLast ? '└──' : '├──';
      const n = shown[i]!;
      // neighbor format: "name (type) [relation]" or "name [relation]"
      lines.push(`${prefix}${branch} ${n}`);

      // 递归子邻居（仅当 depth < 2）
      if (depth < 2) {
        // 从 neighbor string 提取 node ID
        const parts = n.split(' [');
        if (parts.length >= 2) {
          const rel = parts[1]!.replace(']', '');
          if (rel === 'defines' || rel === 'depends_on' || rel === 'calls' || rel === 'imports') {
            // 尝试找子邻居: 这里不能直接从 neighbor string 反查到 node ID
            // 简化处理: 只展示一层深度
          }
        }
      }
    }

    if (neighbors.length > MAX_PER_LEVEL) {
      lines.push(`${prefix}└── (+${neighbors.length - MAX_PER_LEVEL} more)`);
    }
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
  // 持久化
  // --------------------------------------------------------------------------

  /** 序列化四张图为 JSON（用于持久化到磁盘） */
  serialize(): string {
    const data = {
      semantic: {
        nodes: [...this.semanticGraph.nodes.values()],
        edges: this.semanticGraph.edges,
      },
      entity: {
        nodes: [...this.entityGraph.nodes.values()],
        edges: this.entityGraph.edges,
      },
      temporal: this.temporalGraph,
      causal: this.causalGraph,
    };
    return JSON.stringify(data, null, 2);
  }

  /**
   * 从 JSON 反序列化——增量合并到现有数据。
   * 新会话的 Bootstrap 数据会追加到已有节点/边中，不覆盖。
   */
  deserialize(data: string): void {
    try {
      const d = JSON.parse(data) as {
        semantic: { nodes: SemanticNode[]; edges: SemanticEdge[] };
        entity: { nodes: SemanticNode[]; edges: SemanticEdge[] };
        temporal: TemporalEntry[];
        causal: CausalLink[];
      };
      // Merge semantic graph
      for (const n of d.semantic?.nodes ?? []) {
        this.upsertNode(this.semanticGraph, n.id, n.type, n.name, n.path, n.location);
      }
      for (const e of d.semantic?.edges ?? []) {
        this.addEdge(this.semanticGraph, e.from, e.to, e.type);
      }
      // Merge entity graph
      for (const n of d.entity?.nodes ?? []) {
        this.upsertNode(this.entityGraph, n.id, n.type, n.name, n.path, n.location);
      }
      for (const e of d.entity?.edges ?? []) {
        this.addEdge(this.entityGraph, e.from, e.to, e.type);
      }
      // Append temporal + causal
      this.temporalGraph.push(...(d.temporal ?? []));
      this.causalGraph.push(...(d.causal ?? []));
    } catch {
      // 数据损坏 → 静默跳过
    }
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

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
