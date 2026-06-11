// ============================================================
// Assembler — 纯函数 assemble(spec, catalog, resolver?, prefabLoader?)
// 5 阶段管线：Validate → Enrich → Build → Serialize → Clean
// ============================================================

import {
  CompileSpec,
  AssemblerResult,
  RefResolver,
  NOOP_RESOLVER,
  PrefabJson,
} from '../../model/cocos-world.js';
import { ComponentCatalog } from '../../model/component-catalog.js';
import { InternalAssetCatalog } from '../../model/internal-catalog.js';
import { validate } from './validate.js';
import { enrich } from './enrich.js';
import { build } from './build.js';
import { serialize } from './serialize.js';
import { clean, computeStats } from './clean.js';

/**
 * 将 CompileSpec 组装为 Cocos prefab JSON。
 * 纯函数，所有依赖通过参数注入。无线程/模块级可变状态。
 *
 * @param spec         Commander 编译规格
 * @param catalog      统一组件目录
 * @param resolver     引用解析器（schema 驱动）
 * @param prefabLoader 嵌套 prefab 加载器（可选）
 */
export function assemble(
  spec: CompileSpec,
  catalog: ComponentCatalog,
  resolver: RefResolver = NOOP_RESOLVER,
  prefabLoader?: (path: string) => PrefabJson | null,
  internalCatalog?: InternalAssetCatalog,
): AssemblerResult {
  // Stage 1: Validate
  const validationError = validate(spec);
  if (validationError) {
    return {
      ok: false,
      error: validationError.error,
      errorCode: validationError.errorCode,
    };
  }

  // Stage 2: Enrich
  const enriched = enrich(spec, catalog, internalCatalog);

  // Stage 3: Build
  const buildResult = build(enriched, catalog, prefabLoader);
  if (!buildResult.ok) {
    return buildResult;
  }

  // Stage 4: Serialize
  const serialized = serialize(buildResult.flatJson, enriched, catalog, resolver);

  // Stage 5: Clean
  const finalJson = clean(serialized);
  const stats = computeStats(finalJson);

  return { ok: true, json: finalJson, stats };
}

/**
 * 增量子树组装（用于 add-node 编辑操作）。
 * 不创建 Prefab wrapper，保留 __id__ 供 Bridge offset remap。
 */
export function assembleSubtree(
  spec: CompileSpec,
  catalog: ComponentCatalog,
  resolver: RefResolver = NOOP_RESOLVER,
  internalCatalog?: InternalAssetCatalog,
): AssemblerResult & { idMap?: Record<string, number> } {
  // 1. 构建节点树（简化版，无 wrapper）
  const enriched = enrich(spec, catalog, internalCatalog);

  // 使用 build 的简化路径：只建子树
  const buildResult = build(enriched, catalog);
  if (!buildResult.ok) return buildResult;

  // 收集 tempId → localId 映射
  const idMap: Record<string, number> = {};
  for (const ns of enriched.nodes) {
    // 遍历 flatJson 找对应节点
    const nodeObj = buildResult.flatJson.find(
      (o: Record<string, unknown>) => o.__type__ === 'cc.Node' && o._comdr_tempId === ns.tempId,
    );
    if (nodeObj && typeof nodeObj.__id__ === 'number') {
      idMap[ns.tempId] = nodeObj.__id__ as number;
    }
  }

  // 2. Serialize + 半清理（保留 __id__ 供 Bridge offset remap）
  const serialized = serialize(buildResult.flatJson, enriched, catalog, resolver);

  // 清理内部标记但保留 __id__
  const visited = new Set<unknown>();
  function partialClean(obj: unknown): void {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
    visited.add(obj);
    if (Array.isArray(obj)) { for (const item of obj) partialClean(item); return; }
    const record = obj as Record<string, unknown>;
    delete record.tempId;
    delete record._rawProps;
    delete record._comdr_tempId;
    delete record._nestedSource;
    delete record._nestedRoot;
    delete record._prefabInstance;
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') partialClean(value);
    }
  }
  for (const obj of serialized) partialClean(obj);

  const stats = computeStats(serialized);

  return { ok: true, json: serialized, stats, idMap };
}

// Re-export stages for direct use
export { validate } from './validate.js';
export { enrich } from './enrich.js';
export { build } from './build.js';
export { serialize } from './serialize.js';
export { clean, computeStats } from './clean.js';
export { generateFileId } from './id-alloc.js';
