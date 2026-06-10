/**
 * repo-map.ts — Aider-Style Repository Map
 *
 * 来源: Aider — 仓库拓扑压缩视图 (Repository Map).
 *       Whale (2026) — ~98% cache hit 通过稳定性策略.
 *
 * 启动时从 BootstrapReport 生成 <1000 token 的仓库拓扑图。
 * 注入到 prompt L1.5，同会话不变 → DeepSeek 前缀缓存友好。
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

/** repo map 单一符号最大字符数 */
const MAX_SYMBOL_CHARS = 120  // remain as local detail;

/** 私有/内部符号前缀——这些在 map 中省略 */
const SKIP_SYMBOL_PREFIXES = ['_', '__'] as readonly string[];

/** core 目录中总是展示的文件扩展名 */
const MAP_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.rs', '.py', '.go', '.js', '.jsx',
  '.toml', '.yaml', '.yml', '.json',
]);

// ============================================================================
// §2 主函数
// ============================================================================

/**
 * 从 BootstrapReport 生成仓库地图。
 *
 * 格式:
 *   ```
 *   ## Repository Map
 *   src/ (4 files, 12 symbols)
 *   ├── main.ts
 *   │   └── [export] startApp()
 *   └── auth/
 *       ├── auth.ts
 *       │   ├── [export] login()
 *       │   ├── [export] logout()
 *       │   └── AuthService (class)
 *       └── token.ts
 *           └── [export] validate()
 *
 *   Key cross-directory imports:
 *   - auth.ts → cache.ts (AuthService)
 *   - main.ts → auth.ts (startApp)
 *   ```
 *
 * @param report  Bootstrap 静态分析结果
 * @returns       格式化的仓库地图 Markdown 文本，无数据时返回 ''
 */
export function generateRepoMap(report: BootstrapReport | null): string {
  if (!report || report.symbols.length === 0) return '';

  const symbols = filterRelevant(report.symbols);
  if (symbols.length === 0) return '';

  // 按目录分组
  const dirMap = groupByDirectory(symbols);
  const dirs = Object.keys(dirMap).sort();

  const lines: string[] = ['## Repository Map'];

  // ── 目录树 ──
  const crossRefs: string[] = [];
  let totalChars = 0;
  // ★ budgetPerDir 传入 formatFileSymbols() 但当前未被消费——预留接口
  const _budgetPerDir = Math.floor(MAX_REPO_MAP_TOKENS * 3 / dirs.length); // ~3 chars/token

  for (const dir of dirs) {
    const files = dirMap[dir]!;
    if (totalChars > MAX_REPO_MAP_TOKENS * 3) {
      lines.push(`... (+${dirs.length - dirs.indexOf(dir)} more directories, ${symbols.length} more symbols)`);
      break;
    }

    const dirName = dir === '.' ? 'root' : dir;
    lines.push(`${dirName}/`);

    // 文件
    for (const [filePath, syms] of Object.entries(files)) {
      const fmt = formatFileSymbols(filePath, syms, _budgetPerDir);
      lines.push(fmt);
      totalChars += fmt.length;
    }

    // 跨目录引用
    const xrefs = extractCrossRefs(dir, report.references);
    for (const xref of xrefs.slice(0, SYSTEM.REPOMAP_XREFS_PER_DIR)) {
      crossRefs.push(xref);
    }
  }

  // ── 跨目录引用 ──
  if (crossRefs.length > 0) {
    lines.push('');
    lines.push('Key cross-directory imports:');
    for (const ref of crossRefs.slice(0, SYSTEM.REPOMAP_XREFS_TOTAL)) {
      lines.push(`- ${ref}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// §3 辅助函数
// ============================================================================

/**
 * 过滤——移除私有、无意义、非代码文件的符号。
 */
function filterRelevant(symbols: BootstrapSymbol[]): BootstrapSymbol[] {
  return symbols.filter((s) => {
    // 跳过私有（以下划线开头且未导出）
    if (!s.exported && SKIP_SYMBOL_PREFIXES.some((p) => s.name.startsWith(p))) {
      return false;
    }
    // 跳过非关键扩展名的文件
    // ★ 无扩展名的文件（Dockerfile, Makefile, CMakeLists.txt 等）不过滤——
    //   它们可能是重要的构建/配置文件
    const dotIdx = s.file_path.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = s.file_path.slice(dotIdx);
      if (!MAP_FILE_EXTENSIONS.has(ext)) return false;
    }
    return true;
  });
}

/**
 * 按父目录分组符号。
 */
function groupByDirectory(
  symbols: BootstrapSymbol[],
): Record<string, Record<string, BootstrapSymbol[]>> {
  const map: Record<string, Record<string, BootstrapSymbol[]>> = {};
  for (const sym of symbols) {
    const dir = getParentDir(sym.file_path);
    if (!map[dir]) map[dir] = {};
    if (!map[dir]![sym.file_path]) map[dir]![sym.file_path] = [];
    map[dir]![sym.file_path]!.push(sym);
  }
  return map;
}

/**
 * 提取跨目录引用。
 */
function extractCrossRefs(
  dir: string,
  refs: BootstrapReference[],
): string[] {
  const results: string[] = [];
  for (const ref of refs) {
    const fromDir = getParentDir(ref.from_file);
    const toDir = ref.to_file ? getParentDir(ref.to_file) : null;
    if (toDir && toDir !== fromDir && (fromDir === dir || toDir === dir)) {
      results.push(
        `${ref.from_file} → ${ref.to_file} (${ref.to_name})`,
      );
    }
  }
  return results;
}

/**
 * 获取文件路径的父目录。
 */
function getParentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx >= 0 ? filePath.slice(0, idx) : '.';
}

/**
 * 格式化单个文件的符号列表。
 */
function formatFileSymbols(
  filePath: string,
  syms: BootstrapSymbol[],
  _budget: number,
): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const sorted = syms.sort((a, b) => {
    // 导出 > 非导出，class > function > variable
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    const kindOrder: Record<string, number> = { class: 0, interface: 0, function: 1, module: 2, variable: 3 };
    return (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
  });

  let acc = `├── ${fileName}`;
  if (sorted.length === 0) return acc;

  const symbolLines: string[] = [];
  for (const s of sorted.slice(0, SYSTEM.REPOMAP_SYMBOLS_PER_FILE)) {
    const prefix = s.exported ? 'export' : '';
    const loc = s.location ? ` @${s.location}` : '';
    const line = `│   ${prefix ? `[${prefix}] ` : ''}${s.name}${s.kind === 'class' || s.kind === 'interface' ? ` (${s.kind})` : ''}${loc}`;
    if (line.length <= MAX_SYMBOL_CHARS) {
      symbolLines.push(line);
      acc += '\n' + line;
    }
  }

  if (sorted.length > SYSTEM.REPOMAP_SYMBOLS_PER_FILE) {
    acc += `\n│   ... (+${sorted.length - SYSTEM.REPOMAP_SYMBOLS_PER_FILE} more)`;
  }

  return acc;
}
