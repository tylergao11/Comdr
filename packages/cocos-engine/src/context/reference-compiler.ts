// ============================================================
// Reference Compiler — __id__/__uuid__ → 人类可读引用描述
// 后处理模块：遍历编译后的节点树，解析所有引用关系
// ============================================================

import { CompiledNode, CompiledRefProperty } from './types.js';

/** 资源缓存接口（精简版，避免循环依赖） */
interface AssetCacheLike {
  resolve(uuid: string): { path: string } | undefined;
}

/** 内部资源目录接口 */
interface InternalCatalogLike {
  resolve(uuid: string): { name: string; type: string } | undefined;
}

/** 引用编译选项 */
export interface ReferenceCompileOptions {
  /** 节点树 */
  tree: CompiledNode;
  /** AssetCache 实例（可选，有则解析 uuid→path） */
  assetCache?: AssetCacheLike;
  /** InternalAssetCatalog 实例（可选，有则解析 internal uuid） */
  internalCatalog?: InternalCatalogLike;
}

/** 编译后的引用属性（附加到组件摘要上） */
export interface ResolvedRefProp {
  /** 属性名 */
  name: string;
  /** 引用类型 */
  refType: 'node' | 'component' | 'asset';
  /** 当前绑定目标的描述 */
  target: string;
  /** DSL 可用标识符 */
  targetId: string;
}

// ===== 引用解析 =====

/**
 * 解析 Cocos __id__ 引用为节点描述
 * @param id     目标 __id__
 * @param idToNode  __id__ → 节点 fileId 的映射（调用方传入）
 * @param tree   编译后的节点树（用于查找节点路径）
 */
export function resolveIdRef(
  id: number,
  idToNode: Map<number, string>,
  tree?: CompiledNode,
): ResolvedRefProp | null {
  const targetFileId = idToNode.get(id);
  if (!targetFileId) return null;

  const nodePath = tree ? findNodePath(tree, targetFileId) : undefined;
  const nodeName = nodePath || targetFileId.slice(0, 8);

  return {
    name: '',
    refType: 'node',
    target: nodeName,
    targetId: targetFileId,
  };
}

/**
 * 解析 Cocos __uuid__ 引用为资源描述
 */
export function resolveUuidRef(
  uuid: string,
  assetCache?: AssetCacheLike,
  internalCatalog?: InternalCatalogLike,
): ResolvedRefProp | null {
  // 1. 查 AssetCache
  if (assetCache) {
    const cached = assetCache.resolve(uuid);
    if (cached) {
      return {
        name: '',
        refType: 'asset',
        target: cached.path,
        targetId: cached.path,
      };
    }
  }

  // 2. 查 InternalCatalog
  if (internalCatalog) {
    const internal = internalCatalog.resolve(uuid);
    if (internal) {
      return {
        name: '',
        refType: 'asset',
        target: `internal:${internal.name}`,
        targetId: `internal:${internal.name}`,
      };
    }
  }

  // 3. 无法解析 → 返回 UUID 前缀
  return {
    name: '',
    refType: 'asset',
    target: `${uuid.slice(0, 8)}... [未解析]`,
    targetId: uuid,
  };
}

/**
 * 在编译后的节点树中查找节点路径
 */
export function findNodePath(tree: CompiledNode, fileId: string): string | undefined {
  return findNodePathRecursive(tree, fileId);
}

function findNodePathRecursive(node: CompiledNode, fileId: string): string | undefined {
  if (node.fileId === fileId) return `${node.name} (#${node.fileId})`;
  for (const child of node.children) {
    const found = findNodePathRecursive(child, fileId);
    if (found) {
      return `${node.name} / ${found}`;
    }
  }
  return undefined;
}

/**
 * 收集所有节点的 fileId → 节点描述 的扁平映射
 * 包含子节点引用（如 Button→Label）
 */
export function buildIdToNodeMap(tree: CompiledNode): Map<string, string> {
  const map = new Map<string, string>();
  function walk(node: CompiledNode): void {
    map.set(node.fileId, node.name);
    for (const child of node.children) {
      walk(child);
    }
  }
  walk(tree);
  return map;
}
