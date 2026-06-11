// ============================================================
// Assembler Stage 2: Enrich
// 纯函数 enrich(spec, catalog) → CompileSpec
// 统一补全：knowledge 展开 + 默认值 + UITransform 自动补
// engine 和 script 组件同一入口。有 knowledge 则补，没有就跳过。
// ============================================================

import {
  CompileSpec,
  NodeSpec,
  ComponentSpec,
} from '../../model/cocos-world.js';
import { ComponentCatalog, KnowledgeChildNode } from '../../model/component-catalog.js';
import { InternalAssetCatalog, isInternalRef } from '../../model/internal-catalog.js';
import { cloneJson } from '../../foundation/value-kit.js';

/** 自动生成临时 ID 的计数器 */
let _autoIdCounter = 0;
function autoTempId(prefix: string): string {
  return `_${prefix}_${++_autoIdCounter}`;
}
export function resetEnrichCounters(): void {
  _autoIdCounter = 0;
}

/** Enrich：返回一个新的 CompileSpec，包含所有 knowledge 展开。finally 保证计数器即使异常也重置。 */
export function enrich(spec: CompileSpec, catalog: ComponentCatalog, internalCatalog?: InternalAssetCatalog): CompileSpec {
  resetEnrichCounters();
  try {
  const enrichedNodes: NodeSpec[] = [];

  for (const node of spec.nodes) {
    const expanded = expandNode(node, catalog, internalCatalog);
    enrichedNodes.push(...expanded);
  }

  // 去重（可能有 knowledge 展开的子节点与已有节点重名）
  const seen = new Set<string>();
  const deduped: NodeSpec[] = [];
  for (const node of enrichedNodes) {
    if (!seen.has(node.tempId)) {
      seen.add(node.tempId);
      deduped.push(node);
    }
  }

  return { path: spec.path, name: spec.name, nodes: deduped };
  } finally {
    resetEnrichCounters();
  }
}

// ===== 节点展开 =====

/** 需自动补 UITransform 的典型 2D 组件 — 模块级常量，不在循环内反复 new */
const UI_2D_COMPONENTS = new Set([
  'cc.Sprite', 'cc.Label', 'cc.Button', 'cc.Layout', 'cc.Widget',
  'cc.ScrollView', 'cc.EditBox', 'cc.RichText', 'cc.ProgressBar',
  'cc.Slider', 'cc.Toggle', 'cc.PageView', 'cc.UIMeshRenderer',
  'cc.Mask', 'cc.Graphics', 'cc.UIOpacity', 'cc.Canvas',
]);

function expandNode(
  node: NodeSpec,
  catalog: ComponentCatalog,
  internalCatalog?: InternalAssetCatalog,
): NodeSpec[] {
  // 深拷贝：不修改调用方的原始 spec 对象（纯函数契约）
  const cloned: NodeSpec = cloneJson(node);
  const result: NodeSpec[] = [cloned];

  // 1. 解析组件类型 + 合并 knowledge defaults
  const enrichedComponents = enrichComponents(cloned.components, catalog, internalCatalog);

  // 2-4. 单次遍历：UITransform 检测 + requires 补全 + knowledge 子节点展开
  let hasTransform = false;
  let has2dComponent = false;
  const knowledgeToExpand: KnowledgeChildNode[] = [];

  for (const comp of enrichedComponents) {
    const resolved = catalog.resolve(comp.type);
    if (resolved === 'cc.UITransform') hasTransform = true;
    if (UI_2D_COMPONENTS.has(resolved)) has2dComponent = true;

    // requires
    const required = catalog.getRequiredComponents(resolved);
    for (const req of required) {
      if (enrichedComponents.every((c) => catalog.resolve(c.type) !== req)) {
        enrichedComponents.push({ type: req, props: {} });
      }
    }

    // knowledge children
    const knowledge = catalog.knowledgeOf(resolved);
    if (knowledge?.children && knowledge.children.length > 0) {
      for (const childDef of knowledge.children) {
        knowledgeToExpand.push(childDef);
      }
    }
  }

  // 自动补 UITransform
  const needsTransform = has2dComponent || cloned.contentSize || cloned.anchorPoint
    || enrichedComponents.length === 0;
  if (!hasTransform && needsTransform) {
    enrichedComponents.push({
      type: 'cc.UITransform',
      props: {
        anchorX: 0.5,
        anchorY: 0.5,
        contentSize: cloned.contentSize || { width: 100, height: 100 },
        ...(cloned.anchorPoint ? { anchorPoint: cloned.anchorPoint } : {}),
      },
    });
  }

  // knowledge 子节点展开（延迟执行，避免边遍历边改数组）
  for (const childDef of knowledgeToExpand) {
    const childNodes = expandKnowledgeChild(cloned.tempId, childDef, catalog, internalCatalog);
    for (const child of childNodes) result.push(child);
  }

  cloned.components = enrichedComponents;
  return result;
}

// ===== 组件增强 =====

function enrichComponents(
  components: ComponentSpec[],
  catalog: ComponentCatalog,
  internalCatalog?: InternalAssetCatalog,
): ComponentSpec[] {
  const result: ComponentSpec[] = [];
  const seenTypes = new Set<string>();

  for (const comp of components) {
    const resolved = catalog.resolve(comp.type);
    if (seenTypes.has(resolved)) continue;
    seenTypes.add(resolved);

    // 合并 knowledge defaults（Commander 显式指定的优先）
    const knowledgeDefaults = catalog.getKnowledgeDefaults(resolved);
    const mergedProps: Record<string, unknown> = { ...knowledgeDefaults, ...comp.props };

    // 解析 internal:xxx 引用 → { __uuid__: ..., __expectedType__: ... }
    if (internalCatalog) {
      resolveInternalRefs(mergedProps, internalCatalog);
    }

    result.push({ type: resolved, props: mergedProps });
  }

  return result;
}

/** 递归解析 props 中的 internal:xxx 字符串为 Cocos 资产引用。
 *  解析失败（如 Bridge 离线、UUID 未知）→ 回退为 null */
function resolveInternalRefs(props: Record<string, unknown>, internalCatalog: InternalAssetCatalog): void {
  for (const [key, value] of Object.entries(props)) {
    if (isInternalRef(value)) {
      const ref = internalCatalog.resolveToAssetRef(value as string);
      props[key] = ref || null;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      resolveInternalRefs(value as Record<string, unknown>, internalCatalog);
    }
  }
}

// ===== Knowledge 子节点递归展开 =====

function expandKnowledgeChild(
  parentTempId: string,
  childDef: KnowledgeChildNode,
  catalog: ComponentCatalog,
  internalCatalog?: InternalAssetCatalog,
): NodeSpec[] {
  const tempId = autoTempId(childDef.id);
  const result: NodeSpec[] = [];

  const nodeSpec: NodeSpec = {
    tempId,
    name: childDef.name,
    parent: parentTempId,
    components: [],
  };

  // 展开子节点的组件
  const seenTypes = new Set<string>();
  for (const comp of childDef.components) {
    const resolved = catalog.resolve(comp.type);
    if (seenTypes.has(resolved)) continue;
    seenTypes.add(resolved);

    const knowledgeDefaults = catalog.getKnowledgeDefaults(resolved);
    const mergedProps: Record<string, unknown> = { ...knowledgeDefaults, ...(comp.props || {}) };

    // 解析 knowledge child props 中的 internal:xxx 引用
    if (internalCatalog) {
      resolveInternalRefs(mergedProps, internalCatalog);
    }

    nodeSpec.components.push({ type: resolved, props: mergedProps });
  }

  result.push(nodeSpec);

  // 递归展开子节点的子节点
  if (childDef.children) {
    for (const grandchildDef of childDef.children) {
      const gcNodes = expandKnowledgeChild(tempId, grandchildDef, catalog, internalCatalog);
      result.push(...gcNodes);
    }
  }

  return result;
}
