// ============================================================
// Assembler Stage 3: Build
// 纯函数 build(spec, catalog) → { prefabRoot, rootNode, idResult }
// 将 CompileSpec 构建为完整的 Cocos prefab 对象树
// ============================================================

import {
  CompileSpec,
  NodeSpec,
  ComponentSpec,
  BuiltNode,
  BuiltPrefab,
  SerializedComponent,
  SerializedPrefabInfo,
  SerializedCompPrefabInfo,
  CocosVec3,
  CocosQuat,
  CocosSize,
  CocosVec2,
  PREFAB_WRAPPER_TEMPLATE,
  NODE_TEMPLATE,
  PREFAB_INFO_TEMPLATE,
  COMP_PREFAB_INFO_TEMPLATE,
  PREFAB_INSTANCE_TEMPLATE,
  AssemblerResult,
  isEngineComponentType,
  isInfraType,
  IdRef,
  PrefabJson,
} from '../../model/cocos-world.js';
import { ComponentCatalog } from '../../model/component-catalog.js';
import { allocateIds, IdAllocResult, generateFileId } from './id-alloc.js';
import { cloneJson } from '../../foundation/value-kit.js';

export interface BuildResult {
  ok: true;
  prefabRoot: BuiltPrefab;
  rootNode: BuiltNode;
  idResult: IdAllocResult;
  flatJson: PrefabJson;
}

// ===== 入口 =====

export function build(
  spec: CompileSpec,
  catalog: ComponentCatalog,
  prefabLoader?: (path: string) => PrefabJson | null,
): BuildResult | { ok: false; error: string; errorCode: string } {
  // 1. 构建节点树
  const nodeMap = new Map<string, BuiltNode>();

  for (const ns of spec.nodes) {
    const node = createNode(ns, catalog, prefabLoader);
    nodeMap.set(ns.tempId, node);
  }

  // 2. 建立父子关系
  for (const ns of spec.nodes) {
    if (ns.parent && nodeMap.has(ns.parent)) {
      const parent = nodeMap.get(ns.parent)!;
      const child = nodeMap.get(ns.tempId)!;
      parent._children.push(child);
      child._parent = parent;
    }
  }

  // 3. 找根节点
  const rootSpec = spec.nodes.find((n) => !n.parent);
  if (!rootSpec) {
    return { ok: false, error: 'No root node', errorCode: 'ASM_NO_ROOT' };
  }
  const rootNode = nodeMap.get(rootSpec.tempId)!;

  // 4. 创建 Prefab wrapper
  const prefabRoot = cloneJson(PREFAB_WRAPPER_TEMPLATE) as unknown as BuiltPrefab;
  prefabRoot._name = spec.name || rootNode._name || '';

  // 5. PrefabInfo root refs（对象引用，allocateIds 会就地设 __id__，引用自动更新）
  walkAndSetPrefabInfoRoots(rootNode, rootNode);

  // 6. wrapper.data → root（必须在 ID 分配前设置引用，allocator 才能遍历整棵树）
  prefabRoot.data = rootNode as unknown as IdRef;

  // 7. ID 分配：单次遍历整棵树（prefabRoot → data → rootNode → children → components）
  //    prefabRoot 得到 __id__=0，后续对象顺序递增。root refs 自动获得正确 ID。
  const idResult = allocateIds(prefabRoot as unknown as Record<string, unknown>);

  // 8. PrefabInfo.asset → { __id__: 0 }（必须在 ID 分配后，prefabRoot.__id__ 才有值）
  walkAndSetPrefabInfoAssets(rootNode, prefabRoot);

  // 9. Collect nested roots for root PrefabInfo（使用已分配的 __id__）
  const nestedRoots: BuiltNode[] = [];
  collectNestedRoots(rootNode, nestedRoots);
  if (nestedRoots.length > 0) {
    (rootNode._prefab as unknown as Record<string, unknown>).nestedPrefabInstanceRoots =
      nestedRoots.map((n) => ({ __id__: n.__id__ }));
  }

  // 9a. 解析 knowledge refs — 组件字段 → 子节点引用（如 ScrollView._content → content 子节点、Toggle.checkMark → checkmark 子节点）
  resolveKnowledgeRefs(rootNode, catalog);

  // 10. 扁平化
  const flatJson = flattenHierarchy(idResult, prefabRoot, rootNode);

  return {
    ok: true,
    prefabRoot,
    rootNode,
    idResult,
    flatJson,
  };
}

// ===== 节点创建 =====

function createNode(
  spec: NodeSpec,
  catalog: ComponentCatalog,
  _prefabLoader?: (path: string) => PrefabJson | null,
): BuiltNode {
  const node = cloneJson(NODE_TEMPLATE) as unknown as BuiltNode;
  node._name = spec.name;
  node._active = spec.active !== false;
  node._children = [];
  node._components = [];
  node._parent = null;
  node.tempId = spec.tempId;
  node._comdr_tempId = spec.tempId;
  node._id = '';
  node.__id__ = -1; // IdManager 会重新分配

  // Transform
  if (spec.position) {
    node._lpos = {
      __type__: 'cc.Vec3', x: spec.position.x, y: spec.position.y,
      z: spec.position.z ?? 0,
    };
  }
  if (spec.scale) {
    node._lscale = {
      __type__: 'cc.Vec3', x: spec.scale.x, y: spec.scale.y,
      z: spec.scale.z ?? 1,
    };
  }
  if (spec.contentSize) {
    node._contentSize = {
      __type__: 'cc.Size', width: spec.contentSize.width,
      height: spec.contentSize.height,
    };
  }
  if (spec.anchorPoint) {
    node._anchorPoint = {
      __type__: 'cc.Vec2', x: spec.anchorPoint.x,
      y: spec.anchorPoint.y,
    };
  }

  // Components: 按规范化类型去重
  const seenTypes = new Set<string>();
  const droppedProps: string[] = [];
  for (const compSpec of spec.components) {
    const resolved = catalog.resolve(compSpec.type);
    if (seenTypes.has(resolved)) continue;
    seenTypes.add(resolved);

    const { comp, dropped } = buildComponent(compSpec, resolved, catalog);
    droppedProps.push(...dropped);
    comp.node = node as unknown as IdRef;

    const cpi = cloneJson(COMP_PREFAB_INFO_TEMPLATE) as unknown as SerializedCompPrefabInfo;
    cpi.fileId = generateFileId();
    (comp as unknown as Record<string, unknown>).__prefab = cpi;

    node._components.push(comp);
  }

  // 暂存被丢弃的属性名，供 Gateway 反馈给 Commander
  if (droppedProps.length > 0) {
    (node as unknown as Record<string, unknown>)._comdr_dropped = droppedProps;
  }

  // PrefabInfo
  const prefabInfo = cloneJson(PREFAB_INFO_TEMPLATE) as unknown as SerializedPrefabInfo;
  prefabInfo.fileId = generateFileId();
  delete (prefabInfo as Record<string, unknown>).sync;
  node._prefab = prefabInfo;

  return node;
}

function buildComponent(
  spec: ComponentSpec,
  resolvedType: string,
  catalog: ComponentCatalog,
): { comp: SerializedComponent; dropped: string[] } {
  // 类型校验
  if (!spec.type || spec.type === 'cc.' || spec.type === 'cc') {
    throw new Error(
      `Empty component type. Use >schema(component=cc.Type) to find valid types.`,
    );
  }
  if (isInfraType(resolvedType)) {
    throw new Error(
      `"${resolvedType}" is not a component type. Use >schema() to verify.`,
    );
  }

  // 获取模板（engine 有完整模板，script 有最小模板）
  const template = catalog.templateOf(resolvedType);
  const comp = template ? cloneJson(template) : {
    __type__: resolvedType, _name: '', _objFlags: 0,
    node: null, _enabled: true, _id: '',
  };

  // 应用 Commander 指定的属性，捕获被丢弃的 key
  const dropped = applyProps(comp as Record<string, unknown>, spec.props, resolvedType);

  return { comp: comp as unknown as SerializedComponent, dropped };
}

// ===== 属性应用 =====

const FLAT_TO_NESTED: Record<string, string[]> = {
  width: ['_contentSize', 'width'],
  height: ['_contentSize', 'height'],
  anchorX: ['_anchorPoint', 'x'],
  anchorY: ['_anchorPoint', 'y'],
};

const OBJECT_RENAME: Record<string, { target: string; typeKey: string }> = {
  contentSize: { target: '_contentSize', typeKey: 'cc.Size' },
  anchorPoint: { target: '_anchorPoint', typeKey: 'cc.Vec2' },
};

/** 应用 Commander 指定的属性。返回被丢弃的属性名列表（模板中不存在的 key）。
 *  @param compType 组件的规范化类型名（用于限定 FLAT_TO_NESTED/OBJECT_RENAME 仅对 UITransform 生效） */
function applyProps(comp: Record<string, unknown>, props: Record<string, unknown>, compType?: string): string[] {
  const isUITransform = compType === 'cc.UITransform';
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    // 扁平映射（width → _contentSize.width）— 仅 UITransform 有此结构
    if (isUITransform && FLAT_TO_NESTED[key]) {
      const path = FLAT_TO_NESTED[key];
      let target: Record<string, unknown> = comp;
      for (let i = 0; i < path.length - 1; i++) {
        if (!target[path[i]] || typeof target[path[i]] !== 'object') {
          target[path[i]] = {};
        }
        target = target[path[i]] as Record<string, unknown>;
      }
      target[path[path.length - 1]] = value;

      if (['width', 'height'].includes(key) && !(comp._contentSize as Record<string, unknown>)?.__type__) {
        comp._contentSize = { __type__: 'cc.Size', width: 100, height: 100 };
      }
      if (['anchorX', 'anchorY'].includes(key) && !(comp._anchorPoint as Record<string, unknown>)?.__type__) {
        comp._anchorPoint = { __type__: 'cc.Vec2', x: 0.5, y: 0.5 };
      }
      continue;
    }

    // 对象级重命名（contentSize → _contentSize）— 仅 UITransform
    if (isUITransform && value && typeof value === 'object' && !Array.isArray(value) && OBJECT_RENAME[key]) {
      const { target, typeKey } = OBJECT_RENAME[key];
      const existing = comp[target] as Record<string, unknown> | undefined;
      comp[target] = existing?.__type__
        ? { ...existing, ...(value as Record<string, unknown>) }
        : { __type__: typeKey, ...(value as Record<string, unknown>) };
      continue;
    }

    // 标准属性
    const underscored = key.startsWith('_') ? key : '_' + key;
    const targetKey = underscored in comp ? underscored : (key in comp ? key : null);
    // 模板中不存在 → 以 _key 追加但告警 Commander（schema 提取可能不完整，如 Label._string）
    if (!targetKey) {
      comp[underscored] = value;
      dropped.push(key);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = comp[targetKey] as Record<string, unknown> | undefined;
      comp[targetKey] = existing?.__type__
        ? { ...existing, ...(value as Record<string, unknown>) }
        : value;
    } else {
      comp[targetKey] = value;
    }
  }
  return dropped;
}

// ===== PrefabInfo 引用回填 =====

function walkAndSetPrefabInfoRoots(node: BuiltNode, rootNode: BuiltNode): void {
  const pi = node._prefab;
  if (pi) {
    pi.root = node._nestedRoot
      ? (node._nestedRoot as unknown as IdRef)
      : (rootNode as unknown as IdRef);
  }
  for (const child of node._children) {
    walkAndSetPrefabInfoRoots(child, rootNode);
  }
}

function walkAndSetPrefabInfoAssets(node: BuiltNode, prefabRoot: BuiltPrefab): void {
  const pi = node._prefab;
  if (pi) {
    if (node._nestedSource) {
      pi.asset = { __uuid__: node._nestedSource, __expectedType__: 'cc.Prefab' };
    } else {
      pi.asset = { __id__: prefabRoot.__id__ };
    }
  }
  for (const child of node._children) {
    walkAndSetPrefabInfoAssets(child, prefabRoot);
  }
}

function collectNestedRoots(node: BuiltNode, result: BuiltNode[]): void {
  if (node._prefabInstance) result.push(node);
  for (const child of node._children) collectNestedRoots(child, result);
}

/** 遍历整棵树，解析组件 knowledge refs：
 *  如 ScrollView._content → { __id__: contentChild.__id__ }
 *  如 Toggle._checkMark → { __id__: checkmarkChild.__id__ } */
function resolveKnowledgeRefs(rootNode: BuiltNode, catalog: ComponentCatalog): void {
  const walk = (node: BuiltNode): void => {
    for (const comp of node._components) {
      const compType = (comp as unknown as Record<string, unknown>).__type__ as string;
      if (!compType) continue;
      const knowledge = catalog.knowledgeOf(compType);
      if (!knowledge?.refs) continue;

      const compObj = comp as unknown as Record<string, unknown>;
      for (const [propName, ref] of Object.entries(knowledge.refs)) {
        if (ref.targetType !== 'node' || !ref.targetChild) continue;
        // 在子节点中找 knowledge id 匹配的（_comdr_tempId 以 _<childId>_ 开头）
        const found = findChildById(node, ref.targetChild);
        if (found) {
          const targetProp = propName.startsWith('_') ? propName : '_' + propName;
          compObj[targetProp] = { __id__: found.__id__ };
        }
      }
    }
    for (const child of node._children) walk(child);
  };
  walk(rootNode);
}

/** 在节点的所有后代中按 knowledge child id 查找 */
function findChildById(parent: BuiltNode, childId: string): BuiltNode | null {
  // BFS 搜索整棵子树，用 index pointer 替代 shift() 避免 O(n²)
  const queue: BuiltNode[] = [...parent._children];
  let head = 0;
  while (head < queue.length) {
    const child = queue[head++];
    const tempId = (child as unknown as Record<string, unknown>)._comdr_tempId as string;
    if (tempId && tempId.startsWith('_' + childId + '_')) return child;
    if (child._name === childId) return child;
    for (const c of child._children) queue.push(c);
  }
  return null;
}

// ===== 扁平化 =====

function flattenHierarchy(
  idResult: IdAllocResult,
  prefabRoot: BuiltPrefab,
  rootNode: BuiltNode,
): PrefabJson {
  const allObjects = idResult.objects;
  const visited = new Set<number>();
  const result: Record<string, unknown>[] = [];

  // 预建对象 → 下标映射（WeakMap 不支持 number key，用 Map<number, number>）
  // allocateIds 已为每个对象分配唯一 __id__，直接以 __id__ 为 key 索引
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < allObjects.length; i++) {
    idToIndex.set(allObjects[i].__id__ as number, i);
  }
  /** O(1) 查对象在 allObjects 中的下标 */
  function indexOf(obj: Record<string, unknown>): number {
    return idToIndex.get(obj.__id__ as number) ?? -1;
  }

  // 先放 Prefab wrapper（index 0）
  const pfIdx = indexOf(prefabRoot as unknown as Record<string, unknown>);
  if (pfIdx >= 0) {
    visited.add(prefabRoot.__id__ as number);
    result.push(allObjects[pfIdx]);
  }

  // DFS 遍历节点树
  function pushNode(node: BuiltNode): void {
    const nodeIdx = indexOf(node as unknown as Record<string, unknown>);
    if (nodeIdx >= 0 && !visited.has(node.__id__ as number)) {
      visited.add(node.__id__ as number);
      result.push(allObjects[nodeIdx]);
    }
    for (const comp of node._components) {
      const compIdx = indexOf(comp as unknown as Record<string, unknown>);
      if (compIdx >= 0 && !visited.has(comp.__id__ as number)) {
        visited.add(comp.__id__ as number);
        result.push(allObjects[compIdx]);
      }
      // CompPrefabInfo
      const cpi = (comp as unknown as Record<string, unknown>).__prefab as Record<string, unknown> | undefined;
      if (cpi) {
        const cpiIdx = indexOf(cpi);
        if (cpiIdx >= 0 && !visited.has(cpi.__id__ as number)) {
          visited.add(cpi.__id__ as number);
          result.push(allObjects[cpiIdx]);
        }
      }
    }
    // PrefabInfo
    const piIdx = indexOf(node._prefab as unknown as Record<string, unknown>);
    if (piIdx >= 0 && !visited.has(node._prefab.__id__ as number)) {
      visited.add(node._prefab.__id__ as number);
      result.push(allObjects[piIdx]);
    }
    for (const child of node._children) pushNode(child);
  }
  pushNode(rootNode);

  // 剩余对象（嵌套的 PrefabInstance 等）— 用 idToIndex 判定是否已收集
  for (const obj of allObjects) {
    if (!visited.has(obj.__id__ as number)) {
      result.push(obj);
    }
  }

  // 按 ID 排序
  result.sort((a, b) => ((a.__id__ as number) ?? 0) - ((b.__id__ as number) ?? 0));

  return result;
}
