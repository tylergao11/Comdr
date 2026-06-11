/**
 * repo-map.ts — PageRank-Ranked Repository Map
 *
 * 来源: Aider RepoMap + Codebase-Memory + RIG
 *
 * Pipeline:
 *   BootstrapReport → resolve import edges → build file graph
 *   → personalized PageRank → token-budgeted tree → inject L1.5
 *
 * 关键改进（vs 旧字母序目录树）:
 *   1. PageRank 按重要性排序 — 被 import 最多的核心文件排前面
 *   2. 个性化加权 — 对话中已有文件 100× boost，StateWindow 高信用文件 50×
 *   3. 同会话不变 → DeepSeek 前缀缓存友好
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { BootstrapReport, BootstrapReference, BootstrapSymbol } from '@comdr/tools';
import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 常量
// ============================================================================

/** 仓库地图最大 token 数（≈ 字符数 × 0.3） */
const MAX_REPO_MAP_TOKENS = 1000;

/** 单一符号最大字符数 */
const MAX_SYMBOL_CHARS = 120;

/** 私有/内部符号前缀——这些在 map 中省略 */
const SKIP_SYMBOL_PREFIXES = ['_', '__'] as readonly string[];

/** core 目录中总是展示的文件扩展名 */
const MAP_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.rs', '.py', '.go', '.js', '.jsx',
  '.toml', '.yaml', '.yml', '.json',
]);

// ★ PageRank 配置
const PAGERANK_DAMPING = 0.85;
const PAGERANK_MAX_ITER = 100;
const PAGERANK_CONVERGENCE = 1e-6;

/** 个性化权重——对话中已有文件 */
const PERSONALIZATION_CHAT_FILE = 100;
/** 个性化权重——StateWindow 中高信用的文件 */
const PERSONALIZATION_ACTIVE_FILE = 50;

// ============================================================================
// §2 类型
// ============================================================================

/** ★ PageRank 个性化权重 */
export interface PageRankPersonalization {
  /** 对话中已有文件的路径集合 */
  chatFiles: Set<string>;
  /** StateWindow 中信用分 > 0 的文件路径集合 */
  activeFiles: Set<string>;
}

/** 文件图节点 */
interface FileNode {
  path: string;
  outEdges: Set<string>;  // 我 import 了谁
  inEdges: Set<string>;   // 谁 import 了我
}

// ============================================================================
// §3 主函数
// ============================================================================

/**
 * 从 BootstrapReport 生成 PageRank 排序的仓库地图。
 *
 * @param report      Bootstrap 静态分析结果
 * @param personalization  可选——个性化权重
 * @returns           格式化的仓库地图 Markdown 文本，无数据时返回 ''
 */
export function generateRepoMap(
  report: BootstrapReport | null,
  personalization?: PageRankPersonalization,
): string {
  if (!report || report.symbols.length === 0) return '';

  const symbols = filterRelevant(report.symbols);
  if (symbols.length === 0) return '';

  // Step 1: 构建文件级依赖图
  const { graph, fileIndex } = buildFileGraph(report);

  // Step 2: PageRank 排序
  const scores = pageRank(graph, personalization);

  // Step 3: 按 PageRank 分数排序文件
  const symbolsByFile = groupByFile(symbols);
  const rankedFiles = Object.keys(symbolsByFile).sort((a, b) => {
    const sa = scores.get(a) ?? 0;
    const sb = scores.get(b) ?? 0;
    return sb - sa; // 降序——重要文件排前面
  });

  // Step 4: Token-budgeted 格式化
  const lines: string[] = ['## Repository Map'];
  let totalChars = 0;

  for (const filePath of rankedFiles) {
    if (totalChars > MAX_REPO_MAP_TOKENS * 3) {
      const remaining = rankedFiles.length - rankedFiles.indexOf(filePath);
      lines.push(`... (+${remaining} more files)`);
      break;
    }

    const syms = symbolsByFile[filePath]!;
    const score = scores.get(filePath);
    const rankMark = score != null && score > 0.01
      ? ` (p${(score * 100).toFixed(0)})`
      : '';

    const fmt = formatFileSymbols(filePath, syms, rankMark);
    lines.push(fmt);
    totalChars += fmt.length;
  }

  // Step 5: 跨目录引用摘要（取 top 被引文件）
  if (fileIndex.size > 0) {
    const topImported = [...graph.entries()]
      .filter(([, node]) => node.inEdges.size > 0)
      .sort((a, b) => b[1].inEdges.size - a[1].inEdges.size)
      .slice(0, SYSTEM.REPOMAP_XREFS_TOTAL);

    if (topImported.length > 0) {
      lines.push('');
      lines.push('Top imports:');
      for (const [path, node] of topImported) {
        lines.push(`- ${path} ← ${node.inEdges.size} importers`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// §4 PageRank
// ============================================================================

/**
 * 运行个性化 PageRank。
 *
 * 公式: PR = (1-d) * P + d * M^T * PR
 *   d = 0.85 (damping)
 *   P = 个性化向量（对话文件/活跃文件加权）
 *   M = 归一化的邻接矩阵
 *
 * @param graph            文件依赖图
 * @param personalization  可选——个性化权重
 * @returns                文件路径 → PageRank 分数
 */
function pageRank(
  graph: Map<string, FileNode>,
  personalization?: PageRankPersonalization,
): Map<string, number> {
  const nodes = [...graph.keys()];
  const n = nodes.length;
  if (n === 0) return new Map();

  // 索引映射
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(nodes[i]!, i);

  // 初始化: 均匀分布
  let rank = new Float64Array(n);
  const baseRank = 1.0 / n;
  for (let i = 0; i < n; i++) rank[i] = baseRank;

  // 个性化向量: 默认均匀
  const personal = new Float64Array(n);
  if (personalization && (personalization.chatFiles.size > 0 || personalization.activeFiles.size > 0)) {
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const path = nodes[i]!;
      let w = 1.0;
      if (personalization.chatFiles.has(path)) w = PERSONALIZATION_CHAT_FILE;
      else if (personalization.activeFiles.has(path)) w = PERSONALIZATION_ACTIVE_FILE;
      personal[i] = w;
      totalWeight += w;
    }
    // 归一化
    if (totalWeight > 0) {
      for (let i = 0; i < n; i++) personal[i] = personal[i]! / totalWeight;
    }
  } else {
    for (let i = 0; i < n; i++) personal[i] = baseRank;
  }

  // 预计算转移矩阵（列归一化——每个节点的出边均分权重）
  // M[i][j] = 从 j 到 i 的概率
  const outDeg = new Float64Array(n);
  const edges = new Array<{ from: number; to: number; weight: number }>();
  for (const [path, node] of graph) {
    const from = idx.get(path)!;
    const outCount = node.outEdges.size;
    if (outCount === 0) {
      outDeg[from] = 0;
      continue;
    }
    const w = 1.0 / outCount;
    for (const target of node.outEdges) {
      const to = idx.get(target);
      if (to != null) {
        edges.push({ from, to, weight: w });
      }
    }
  }

  // 迭代
  for (let iter = 0; iter < PAGERANK_MAX_ITER; iter++) {
    const newRank = new Float64Array(n);

    // 个性化部分
    for (let i = 0; i < n; i++) {
      newRank[i] = (1 - PAGERANK_DAMPING) * personal[i]!;
    }

    // 转移部分
    for (const { from, to, weight } of edges) {
      newRank[to] = newRank[to]! + PAGERANK_DAMPING * rank[from]! * weight;
    }

    // ★ damping 修正: 处理 dangling nodes（无出边的节点）
    // 它们的 rank 均匀分配给所有节点
    let danglingSum = 0.0;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) danglingSum += rank[i]!;
    }
    if (danglingSum > 0) {
      const distribute = PAGERANK_DAMPING * danglingSum / n;
      for (let i = 0; i < n; i++) newRank[i] = newRank[i]! + distribute;
    }

    // 收敛检查
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(newRank[i]! - rank[i]!);
    }
    if (diff < PAGERANK_CONVERGENCE) break;

    rank = newRank;
  }

  // 结果
  const scores = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    scores.set(nodes[i]!, rank[i]!);
  }
  return scores;
}

// ============================================================================
// §5 文件图构建
// ============================================================================

/**
 * 从 BootstrapReport 构建文件级依赖图。
 *
 * 边方向: A import B → A→B (A 依赖 B)
 *
 * @returns { graph, fileIndex } — graph 是 Map<filePath, FileNode>；
 *          fileIndex 是 basename → filePath 的快速查找表
 */
function buildFileGraph(
  report: BootstrapReport,
): { graph: Map<string, FileNode>; fileIndex: Map<string, string> } {
  const graph = new Map<string, FileNode>();

  function getOrCreate(path: string): FileNode {
    let node = graph.get(path);
    if (!node) {
      node = { path, outEdges: new Set(), inEdges: new Set() };
      graph.set(path, node);
    }
    return node;
  }

  // 确保所有扫描的文件都有节点（即使没有引用）
  for (const f of report.files_scanned) {
    getOrCreate(f);
  }

  // 构建 basename → path 索引（用于解析相对 import）
  const fileIndex = new Map<string, string>();
  for (const f of report.files_scanned) {
    const basename = f.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? f;
    // 同名文件保留第一个（通常是核心路径）
    if (!fileIndex.has(basename)) {
      fileIndex.set(basename, f);
    }
  }

  // 从引用构建边
  for (const ref of report.references) {
    const fromFile = ref.from_file;
    let toFile = resolveImportPath(ref, fileIndex);

    // 如果无法解析，跳过
    if (!toFile) continue;

    const from = getOrCreate(fromFile);
    const to = getOrCreate(toFile);

    from.outEdges.add(toFile);
    to.inEdges.add(fromFile);
  }

  return { graph, fileIndex };
}

/**
 * 尝试将 import 路径解析为实际文件路径。
 *
 * 策略（按优先级）:
 *   1. 精确匹配——to_file 在 files_scanned 中
 *   2. basename 匹配——用 to_file 的文件名查 fileIndex
 *   3. 相对路径解析——处理 ./foo → foo.ts 之类
 */
function resolveImportPath(
  ref: BootstrapReference,
  fileIndex: Map<string, string>,
): string | null {
  // 跳过外部模块
  if (!ref.to_file) return null;

  const target = ref.to_file.replace(/\\/g, '/');

  // 策略 1: 精确匹配
  if (fileIndex.has(target)) return target;

  // 策略 2: basename 匹配
  const basename = target.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (basename) {
    const resolved = fileIndex.get(basename);
    if (resolved) return resolved;
  }

  // 策略 3: 相对路径——在 from_file 的目录下尝试常见扩展名
  const fromDir = ref.from_file.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  if (target.startsWith('.')) {
    const resolved = resolveRelative(fromDir, target, fileIndex);
    if (resolved) return resolved;
  }

  // 策略 4: 模糊匹配——target 的最后一段出现在某个 fileIndex key 中
  for (const [key, val] of fileIndex) {
    if (key.endsWith(basename ?? '') || val.endsWith(target)) {
      return val;
    }
  }

  return null;
}

/**
 * 解析相对路径（如 ./foo, ../bar）。
 */
function resolveRelative(
  fromDir: string,
  relative: string,
  fileIndex: Map<string, string>,
): string | null {
  const parts = fromDir.split('/').filter(Boolean);
  const relParts = relative.split('/');

  for (const seg of relParts) {
    if (seg === '..') {
      parts.pop();
    } else if (seg !== '.') {
      parts.push(seg);
    }
  }

  const candidate = parts.join('/');

  // 尝试直接匹配
  if (fileIndex.has(candidate)) return candidate;

  // 尝试加常见扩展名
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.rs', '.py']) {
    const withExt = candidate + ext;
    if (fileIndex.has(withExt)) return withExt;
  }

  // 尝试 index 文件
  for (const ext of ['.ts', '.tsx', '.js', '.rs']) {
    const indexPath = candidate + '/index' + ext;
    if (fileIndex.has(indexPath)) return indexPath;
  }

  return null;
}

// ============================================================================
// §6 格式化（复用原逻辑）
// ============================================================================

/**
 * 过滤——移除私有、无意义、非代码文件的符号。
 */
function filterRelevant(symbols: BootstrapSymbol[]): BootstrapSymbol[] {
  return symbols.filter((s) => {
    if (!s.exported && SKIP_SYMBOL_PREFIXES.some((p) => s.name.startsWith(p))) {
      return false;
    }
    const dotIdx = s.file_path.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = s.file_path.slice(dotIdx);
      if (!MAP_FILE_EXTENSIONS.has(ext)) return false;
    }
    return true;
  });
}

/**
 * 按文件路径分组符号。
 */
function groupByFile(
  symbols: BootstrapSymbol[],
): Record<string, BootstrapSymbol[]> {
  const map: Record<string, BootstrapSymbol[]> = {};
  for (const sym of symbols) {
    if (!map[sym.file_path]) map[sym.file_path] = [];
    map[sym.file_path]!.push(sym);
  }
  return map;
}

/**
 * 格式化单个文件的符号列表。
 */
function formatFileSymbols(
  filePath: string,
  syms: BootstrapSymbol[],
  rankMark: string,
): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const sorted = syms.sort((a, b) => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    const kindOrder: Record<string, number> = { class: 0, interface: 0, function: 1, module: 2, variable: 3 };
    return (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
  });

  let acc = `├── ${fileName}${rankMark}`;
  if (sorted.length === 0) return acc;

  for (const s of sorted.slice(0, SYSTEM.REPOMAP_SYMBOLS_PER_FILE)) {
    const prefix = s.exported ? 'export' : '';
    const loc = s.location ? ` @${s.location}` : '';
    const line = `│   ${prefix ? `[${prefix}] ` : ''}${s.name}${s.kind === 'class' || s.kind === 'interface' ? ` (${s.kind})` : ''}${loc}`;
    if (line.length <= MAX_SYMBOL_CHARS) {
      acc += '\n' + line;
    }
  }

  if (sorted.length > SYSTEM.REPOMAP_SYMBOLS_PER_FILE) {
    acc += `\n│   ... (+${sorted.length - SYSTEM.REPOMAP_SYMBOLS_PER_FILE} more)`;
  }

  return acc;
}
