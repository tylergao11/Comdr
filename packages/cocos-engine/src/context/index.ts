// ============================================================
// Context Compiler — 主编入口
// compileSchema + compileSceneTree + compileReferences + analyzeInsertionPoints
// ============================================================

import { CompiledContext, CompiledSchema } from './types.js';
import { compileSchema } from './schema-compiler.js';
import { compileSceneTree } from './scene-compiler.js';
import { findNodePath } from './reference-compiler.js';
import { analyzeInsertionPoints } from './insertion-analyzer.js';
import { ComponentEntry } from '../model/component-catalog.js';
import { RefResolver } from '../model/cocos-world.js';

// ===== 编译选项 =====

export interface ContextCompileOptions {
  /** 编译哪个组件的 schema */
  schemaEntries?: Array<{ entry: ComponentEntry; resolver?: RefResolver }>;
  /** 场景 JSON（probe document-serialize 结果） */
  sceneJson?: unknown[];
  /** 场景编译选项 */
  sceneOpts?: {
    depth?: number | 'all';
    detail?: 'structure' | 'full';
    focus?: string;
  };
  /** 资产列表 */
  assets?: Array<{ name: string; path: string; isDir: boolean; importer?: string }>;
  /** 脚本列表 */
  scripts?: Array<{ name: string; path: string; compressedId: string }>;
  /** 当前文档信息 */
  document?: {
    kind: 'prefab' | 'scene';
    path: string;
    name: string;
    rootFileId?: string;
  };
  /** 编译提示 */
  hints?: string;
}

// ===== 主入口 =====

/**
 * 编译上下文 — BLUEPRINT
 * 输入: Schema 条目 + Probe 结果
 * 输出: 编译后的蓝图（CompiledContext）
 */
export function compileContext(opts: ContextCompileOptions): CompiledContext {
  const warnings: string[] = [];

  // 1. Schema 编译
  const schemas: CompiledSchema[] = [];
  if (opts.schemaEntries) {
    for (const { entry, resolver } of opts.schemaEntries) {
      try {
        schemas.push(compileSchema(entry, resolver));
      } catch (e) {
        warnings.push(`Schema compile failed for ${entry.identity.rawType}: ${(e as Error).message}`);
      }
    }
  }

  // 2. 场景树编译
  let tree = undefined;
  if (opts.sceneJson && Array.isArray(opts.sceneJson) && opts.sceneJson.length > 0) {
    try {
      tree = compileSceneTree(opts.sceneJson, opts.sceneOpts);
      // 后处理：注入节点路径
      if (tree) {
        setNodePaths(tree, '');
      }
    } catch (e) {
      warnings.push(`Scene tree compile failed: ${(e as Error).message}`);
    }
  }

  // 3. 插入点分析
  let insertionPoints = undefined;
  if (tree) {
    try {
      insertionPoints = analyzeInsertionPoints(tree);
    } catch (e) {
      warnings.push(`Insertion analysis failed: ${(e as Error).message}`);
    }
  }

  // 4. 资产列表
  const compiledAssets = opts.assets?.map((a) => ({
    name: a.name,
    path: a.path,
    isDir: a.isDir,
    importer: a.importer,
  }));

  // 5. 构建摘要
  const summary = buildSummary(opts, tree, schemas);

  return {
    schema: 'Comdr.compiled-context.v1',
    document: opts.document,
    tree,
    schemas,
    assets: compiledAssets,
    scripts: opts.scripts,
    insertionPoints,
    summary,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ===== 辅助 =====

/** 递归为树中每个节点设置路径 */
function setNodePaths(node: import('./types.js').CompiledNode, parentPath: string): void {
  const path = parentPath ? `${parentPath}/${node.name}` : `/${node.name}`;
  (node as { path: string }).path = path;
  for (const child of node.children) {
    setNodePaths(child, path);
  }
}

/** 构建简要摘要 */
function buildSummary(
  opts: ContextCompileOptions,
  tree: import('./types.js').CompiledNode | undefined,
  schemas: CompiledSchema[],
): string {
  const parts: string[] = [];

  if (opts.document) {
    parts.push(`文档: ${opts.document.kind}=${opts.document.path}`);
  }

  if (tree) {
    const nodeCount = countNodes(tree);
    parts.push(`${nodeCount} 个节点`);
  }

  if (schemas.length > 0) {
    parts.push(`${schemas.length} 个 schema`);
  }

  if (opts.assets) {
    parts.push(`${opts.assets.length} 个资源`);
  }

  if (opts.scripts) {
    parts.push(`${opts.scripts.length} 个脚本`);
  }

  return parts.join(', ');
}

/** 递归计数节点 */
function countNodes(node: import('./types.js').CompiledNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

// 导出子模块
export { compileSchema } from './schema-compiler.js';
export { compileSceneTree } from './scene-compiler.js';
export { findNodePath, buildIdToNodeMap } from './reference-compiler.js';
export { analyzeInsertionPoints } from './insertion-analyzer.js';
