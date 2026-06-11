// ============================================================
// Scene Compiler — Cocos PrefabJson → CompiledNode 层级树
// ★ 精准供给: 默认 depth=3 structure，LLM 显式 depth=all detail=full 才展开。
// 编排层决定默认喂多少，LLM 决定要不要更多。
// ============================================================

import { CompiledNode, CompiledComponentSummary, CompiledRefProperty } from './types.js';
import { VALUE_TYPE_NAMES, VALUE_TYPE_TEMPLATES } from '../model/cocos-world.js';

// ===== 内部类型 =====

interface CocosObj {
  __type__?: string;
  __id__?: number;
  __deleted__?: boolean;
  _name?: string;
  _children?: Array<{ __id__: number }>;
  _components?: Array<{ __id__: number }>;
  _prefab?: { __id__: number };
  __prefab?: { __id__: number };
  _parent?: { __id__: number } | null;
  _active?: boolean;
  _contentSize?: { width: number; height: number };
  _anchorPoint?: { x: number; y: number };
  _lpos?: { x: number; y: number; z: number };
  _lrot?: { x: number; y: number; z: number; w: number };
  _lscale?: { x: number; y: number; z: number };
  _layer?: number;
  fileId?: string;
  node?: { __id__: number };
  [key: string]: unknown;
}

interface ComponentInfo {
  type: string;
  fileId?: string;
  props: Record<string, unknown>;
}

interface NodeInfo {
  fileId: string;
  name: string;
  children: NodeInfo[];
  components: ComponentInfo[];
  active: boolean;
  contentSize?: { width: number; height: number };
}

/** 系统内部属性 — 不展示 */
const SKIP_PROPS = new Set([
  '__type__', '__id__', '__deleted__',
  '_name', '_objFlags', '_id',
  'node', '_prefab', '__prefab',
  '_parent', '_children', '_components',
  'root', 'asset', 'data',
  'fileId', 'sync', '_enabled',
  '_target', '__editorExtras__',
  '_lpos', '_lrot', '_lscale', '_layer',
  'mountedChildren', 'mountedComponents',
  'propertyOverrides', 'removedComponents',
  'prefabRootNode', 'instance', 'nestedPrefabInstanceRoots',
]);

// ===== 公开 API =====

export interface SceneCompileOptions {
  /** 子树深度限制，默认 3 */
  depth?: number | 'all';
  /** 详情级别: structure (仅组件类型) | full (含属性值)，默认 structure */
  detail?: 'structure' | 'full';
  /** 以指定 fileId 的节点为中心（显示祖先链 + 子树） */
  focus?: string;
}

/**
 * 从 Cocos PrefabJson 编译场景树
 * @param json  Prefab JSON 扁平数组
 * @param options 编译选项
 * @returns 编译后的根节点树，根为 null 时返回 undefined
 */
export function compileSceneTree(
  json: unknown[],
  options: SceneCompileOptions = {},
): CompiledNode | undefined {
  const objs = json as CocosObj[];
  const detail = options.detail || 'structure';
  const depth = options.depth ?? 3;   // ★ 默认 3 层，不再 all
  const focus = options.focus;

  // 1. 索引: __id__ → CocosObj
  const idMap = new Map<number, CocosObj>();
  for (const obj of objs) {
    if (obj.__id__ !== undefined && !obj.__deleted__) {
      idMap.set(obj.__id__, obj);
    }
  }

  // 2. 解析所有节点
  const nodes = findNodes(objs, idMap);
  if (nodes.length === 0) return undefined;

  // 3. 建立 fileId → NodeInfo 索引（用于 focus 查找）
  const fileIdMap = new Map<string, NodeInfo>();
  for (const n of nodes) {
    fileIdMap.set(n.fileId, n);
  }

  // 3b. 建立 parent map: child fileId → parent fileId（focus 模式回溯祖先链用）
  const parentMap = new Map<string, string>();
  for (const raw of objs) {
    if (raw.__type__ !== 'cc.Node' || raw.__deleted__) continue;
    if (!raw._parent) continue;
    const childFid = getFileIdFromNode(raw, idMap);
    const parentRaw = idMap.get(raw._parent.__id__);
    if (!parentRaw || !childFid) continue;
    const parentFid = getFileIdFromNode(parentRaw, idMap);
    if (parentFid) parentMap.set(childFid, parentFid);
  }

  // 4. 找根节点（_parent 为 null 或 __id__ 为 1 的 Node）
  let roots = nodes.filter((n) => {
    const raw = findNodeRaw(objs, n.fileId, idMap);
    if (!raw) return false;
    return raw._parent === null || raw._parent === undefined;
  });

  // 根节点回退：找 __id__ === 1 的 Node
  if (roots.length === 0) {
    roots = nodes.filter((n) => {
      const raw = findNodeRaw(objs, n.fileId, idMap);
      return raw?.__id__ === 1;
    });
  }

  // 5. 如果有 focus，构建祖先链 + 焦点子树
  let rootNodes = roots;
  let focusChain: NodeInfo[] | undefined;
  if (focus && fileIdMap.has(focus)) {
    const focused = fileIdMap.get(focus)!;

    // 5a. 回溯祖先链（从 focus 往上走到根）
    const chain: NodeInfo[] = [focused];
    let current = focus;
    while (parentMap.has(current)) {
      const parentFid = parentMap.get(current)!;
      const parentNode = fileIdMap.get(parentFid);
      if (!parentNode || chain.some((n) => n.fileId === parentNode.fileId)) break; // 防止环
      chain.unshift(parentNode);
      current = parentFid;
    }

    // 5b. 构建骨架树：每层祖先只保留链上下一个子节点，其余剪枝
    //   最顶层祖先 → ... → focus（完整展开）
    for (let i = 0; i < chain.length - 1; i++) {
      const ancestor = chain[i]!;
      const descendant = chain[i + 1]!;
      ancestor.children = [descendant];
    }
    rootNodes = [chain[0]!];
    focusChain = chain;
  }

  if (rootNodes.length === 0) return undefined;

  // 6. 编译为 CompiledNode 树
  const root = rootNodes[0];
  const focusDepth = focusChain ? focusChain.length - 1 : undefined;
  const compiled = compileNode(root, 0, depth, detail, focusDepth);
  return compiled;
}

// ===== 内部函数 =====

/** 从 flat array 中找出所有 Node 对象 */
function findNodes(objs: CocosObj[], idMap: Map<number, CocosObj>): NodeInfo[] {
  const nodeObjs = objs.filter(
    (o) => o.__type__ === 'cc.Node' && !o.__deleted__,
  );

  const result: NodeInfo[] = [];
  for (const nodeObj of nodeObjs) {
    // 通过 _prefab → PrefabInfo 找 fileId
    let fileId = '';
    if (nodeObj._prefab && nodeObj._prefab.__id__ !== undefined) {
      const prefabInfo = idMap.get(nodeObj._prefab.__id__);
      if (prefabInfo?.fileId) fileId = prefabInfo.fileId as string;
    }
    // 回退：直接读 _id
    if (!fileId && nodeObj._id) fileId = nodeObj._id as string;

    const name = (nodeObj._name as string) || 'Unnamed';

    // 提取组件
    const components: ComponentInfo[] = [];
    if (nodeObj._components) {
      for (const compRef of nodeObj._components) {
        const compObj = idMap.get(compRef.__id__);
        if (!compObj || compObj.__deleted__) continue;

        const compType = (compObj.__type__ as string) || '';
        // 跳过基础设施类型
        if (compType === 'cc.PrefabInfo' || compType === 'cc.CompPrefabInfo') continue;

        let compFileId: string | undefined;
        if (compObj.__prefab && compObj.__prefab.__id__ !== undefined) {
          const cpi = idMap.get(compObj.__prefab.__id__);
          if (cpi?.fileId) compFileId = cpi.fileId as string;
        }

        const props = extractKeyProps(compObj);
        components.push({ type: compType, fileId: compFileId, props });
      }
    }

    // 建 NodeInfo
    const info: NodeInfo = {
      fileId,
      name,
      children: [],
      components,
      active: nodeObj._active !== false,
      contentSize: nodeObj._contentSize,
    };
    result.push(info);
  }

  // 建立父子关系
  for (const nodeObj of nodeObjs) {
    const fileId = getFileIdFromNode(nodeObj, idMap);
    const info = result.find((n) => n.fileId === fileId);
    if (!info) continue;

    if (nodeObj._children) {
      for (const childRef of nodeObj._children) {
        const childInfo = findNodeByObjId(result, nodeObj, childRef.__id__, objs, idMap);
        if (childInfo && !info.children.includes(childInfo)) {
          info.children.push(childInfo);
        }
      }
    }
  }

  return result;
}

/** 从 Node 原始对象找 fileId */
function getFileIdFromNode(nodeObj: CocosObj, idMap: Map<number, CocosObj>): string {
  if (nodeObj._prefab && nodeObj._prefab.__id__ !== undefined) {
    const prefabInfo = idMap.get(nodeObj._prefab.__id__);
    if (prefabInfo?.fileId) return prefabInfo.fileId as string;
  }
  return (nodeObj._id as string) || '';
}

/** 从 Node 的 _children[].__id__ 找到对应的 NodeInfo */
function findNodeByObjId(
  all: NodeInfo[],
  nodeObj: CocosObj,
  childId: number,
  objs: CocosObj[],
  idMap: Map<number, CocosObj>,
): NodeInfo | undefined {
  const childObj = idMap.get(childId);
  if (!childObj) return undefined;
  const fileId = getFileIdFromNode(childObj, idMap);
  return all.find((n) => n.fileId === fileId);
}

/** 反向查 Node 原始对象 */
function findNodeRaw(
  objs: CocosObj[],
  fileId: string,
  idMap: Map<number, CocosObj>,
): CocosObj | undefined {
  for (const obj of objs) {
    if (obj.__type__ !== 'cc.Node' || obj.__deleted__) continue;
    const fid = getFileIdFromNode(obj, idMap);
    if (fid === fileId) return obj;
  }
  return undefined;
}

/** 从组件对象提取关键属性 */
function extractKeyProps(compObj: CocosObj): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(compObj)) {
    if (SKIP_PROPS.has(key)) continue;
    if (typeof val === 'object' && val !== null) {
      const inner = val as Record<string, unknown>;
      // 值类型内联对象 → 展开
      if (inner.__type__ && VALUE_TYPE_NAMES.has(inner.__type__ as string)) {
        props[stripUnderscore(key)] = formatValue(val as Record<string, unknown>);
        continue;
      }
      // 引用 → 跳过（由 reference-compiler 处理）
      if (inner.__id__ !== undefined || inner.__uuid__ !== undefined) continue;
      continue;
    }
    props[stripUnderscore(key)] = val;
  }
  return props;
}

/** 格式化 Cocos 值类型 */
function formatValue(val: Record<string, unknown>): string {
  const t = val.__type__ as string;
  switch (t) {
    case 'cc.Vec2':
      return `(${val.x}, ${val.y})`;
    case 'cc.Vec3':
      return `(${val.x}, ${val.y}, ${val.z})`;
    case 'cc.Size':
      return `${val.width}×${val.height}`;
    case 'cc.Color':
      return `rgba(${val.r},${val.g},${val.b},${val.a})`;
    case 'cc.Rect':
      return `(${val.x},${val.y}) ${val.width}×${val.height}`;
    default:
      return JSON.stringify(val);
  }
}

// isValueType 使用 cocos-world.ts 的 VALUE_TYPE_NAMES（单一真实源）

function stripUnderscore(name: string): string {
  return name.startsWith('_') ? name.slice(1) : name;
}

/**
 * 递归编译 CompiledNode。
 *
 * @param focusDepth  焦点节点所在的深度——祖先层（depth < focusDepth）只给骨架
 */
function compileNode(
  info: NodeInfo,
  depth: number,
  maxDepth: number | 'all',
  detail: 'structure' | 'full',
  focusDepth?: number,
): CompiledNode {
  // ★ focus 模式：祖先节点 → skeleton（仅名字 + 组件类型，无属性值）
  const isAncestor = focusDepth !== undefined && depth < focusDepth;
  const effectiveDetail = isAncestor ? 'structure' : detail;

  const compiledComps: CompiledComponentSummary[] = info.components.map((c) => ({
    type: c.type,
    keyProps: effectiveDetail === 'full' ? c.props : {},
  }));

  const compiled: CompiledNode = {
    fileId: info.fileId,
    name: info.name,
    depth,
    path: '',
    components: compiledComps,
    children: [],
  };

  // 递归子节点
  const childDepth = depth + 1;
  const shouldDescend = maxDepth === 'all' || (typeof maxDepth === 'number' && childDepth <= maxDepth);

  if (shouldDescend) {
    for (const child of info.children) {
      compiled.children.push(compileNode(child, childDepth, maxDepth, detail, focusDepth));
    }
  }

  return compiled;
}
