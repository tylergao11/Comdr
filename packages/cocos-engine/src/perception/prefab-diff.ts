// ============================================================
// PrefabDiff — 结构化资源差异计算
// 以 PrefabInfo.fileId 为稳定 ID 匹配前后节点
// 不依赖 bridge 包，在 core 内独立实现
// ============================================================

import { DIFF_VALUE_MAX, DIFF_OBJ_MAX } from '../foundation/constants.js';

// ===== 通用 JSON 对象类型 =====

interface CocosObject {
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
  _enabled?: boolean;
  node?: { __id__: number };
  fileId?: string;
  [key: string]: unknown;
}

// ===== 差异输出类型 =====

/** DiffEntry.type — 通过 DiffEntry 间接使用，非直接 import */
export type DiffType = 'added' | 'removed' | 'modified';

export interface DiffEntry {
  type: DiffType;
  nodeName: string;
  nodeId: string; // PrefabInfo.fileId
  componentType?: string;
  property?: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  /** 人可读摘要，例如 "Button: normalColor #FFF → #F00" */
  summary: string;
}

export interface PrefabDiffResult {
  path: string;
  entries: DiffEntry[];
  empty: boolean; // 无差异时为 true
}

// ===== 内部结构 =====

interface ComponentInfo {
  fileId: string; // CompPrefabInfo.fileId
  type: string;
  props: Record<string, unknown>;
}

interface NodeInfo {
  fileId: string;
  name: string;
  components: ComponentInfo[];
  active: boolean;
  /** 父节点 fileId，根节点为 null */
  parentId: string | null;
}

// ===== 忽略的字段（系统字段，非用户可见属性） =====

const SKIP_KEYS = new Set([
  '__type__', '__id__', '__deleted__',
  '_name', '_objFlags', '_id', '_rawProps',
  'node', '_prefab', '__prefab',
  '_parent', '_children', '_components',
  'root', 'asset', 'data',
  'fileId', 'sync',
]);

// ===== 公开 API =====

/** 比较两个 prefab JSON 数组，返回结构化差异 */
export function diffPrefab(
  path: string,
  before: unknown[],
  after: unknown[]
): PrefabDiffResult {
  const beforeNodes = extractNodes(before as CocosObject[]);
  const afterNodes = extractNodes(after as CocosObject[]);

  const entries: DiffEntry[] = [];

  // Collect all node fileIds
  const beforeIds = new Set(beforeNodes.keys());
  const afterIds = new Set(afterNodes.keys());

  // Removed: in before but not in after
  for (const fileId of beforeIds) {
    if (!afterIds.has(fileId)) {
      const node = beforeNodes.get(fileId);
      if (!node) continue;
      entries.push({
        type: 'removed',
        nodeName: node.name,
        nodeId: fileId,
        summary: `Node removed: ${node.name}`,
      });
    }
  }

  // Added: in after but not in before
  for (const fileId of afterIds) {
    if (!beforeIds.has(fileId)) {
      const node = afterNodes.get(fileId);
      if (!node) continue;
      entries.push({
        type: 'added',
        nodeName: node.name,
        nodeId: fileId,
        summary: `Node added: ${node.name}${node.components.length > 0 ? ` (${node.components.map(c => shortType(c.type)).join(', ')})` : ''}`,
      });
    }
  }

  // Modified: in both, compare components
  for (const fileId of beforeIds) {
    if (!afterIds.has(fileId)) continue;
    const before = beforeNodes.get(fileId);
    const after = afterNodes.get(fileId);
    if (!before || !after) continue;

    // Compare active state
    if (before.active !== after.active) {
      entries.push({
        type: 'modified',
        nodeName: before.name,
        nodeId: fileId,
        property: '_active',
        beforeValue: before.active,
        afterValue: after.active,
        summary: `${before.name}._active: ${before.active} → ${after.active}`,
      });
    }

    // Compare components by type
    const beforeComps = new Map<string, ComponentInfo>();
    for (const c of before.components) beforeComps.set(c.type, c);
    const afterComps = new Map<string, ComponentInfo>();
    for (const c of after.components) afterComps.set(c.type, c);

    // Components removed
    for (const [type, comp] of beforeComps) {
      if (!afterComps.has(type)) {
        entries.push({
          type: 'modified',
          nodeName: before.name,
          nodeId: fileId,
          componentType: type,
          summary: `${before.name}: component removed: ${shortType(type)}`,
        });
      }
    }

    // Components added
    for (const [type, _comp] of afterComps) {
      if (!beforeComps.has(type)) {
        entries.push({
          type: 'modified',
          nodeName: before.name,
          nodeId: fileId,
          componentType: type,
          summary: `${before.name}: component added: ${shortType(type)}`,
        });
      }
    }

    // Components in both: compare properties
    for (const [type, afterComp] of afterComps) {
      const beforeComp = beforeComps.get(type);
      if (!beforeComp) continue;

      const propDiffs = diffProperties(beforeComp.props, afterComp.props);
      for (const pd of propDiffs) {
        entries.push({
          type: 'modified',
          nodeName: before.name,
          nodeId: fileId,
          componentType: type,
          property: pd.key,
          beforeValue: pd.before,
          afterValue: pd.after,
          summary: `${before.name}.${shortType(type)}.${pd.key}: ${formatVal(pd.before)} → ${formatVal(pd.after)}`,
        });
      }
    }

    // Name change
    if (before.name !== after.name) {
      entries.push({
        type: 'modified',
        nodeName: after.name,
        nodeId: fileId,
        property: '_name',
        beforeValue: before.name,
        afterValue: after.name,
        summary: `Node renamed: ${before.name} → ${after.name}`,
      });
    }
  }

  return {
    path,
    entries,
    empty: entries.length === 0,
  };
}

/** 批量 diff，返回所有有差异的结果 */
export function diffAllSnapshots(
  snapshots: Array<{ path: string; before: unknown[]; after: unknown[] }>
): PrefabDiffResult[] {
  return snapshots.map((s) => diffPrefab(s.path, s.before, s.after));
}

/** 汇总差异为多行文本 */
export function formatDiffResults(diffs: PrefabDiffResult[]): string {
  if (!diffs || diffs.length === 0) return '';

  const lines: string[] = [];
  let totalEntries = 0;

  for (const diff of diffs) {
    if (diff.empty) {
      lines.push(`[no changes] ${diff.path}`);
      continue;
    }
    lines.push(`## ${diff.path} (${diff.entries.length} changes)`);
    const byType = groupBy(diff.entries, (e) => e.type);
    for (const type of ['added', 'removed', 'modified'] as DiffType[]) {
      const group = byType.get(type);
      if (!group || group.length === 0) continue;
      lines.push(`  ${type}:`);
      for (const e of group) {
        lines.push(`    - ${e.summary}`);
      }
    }
    totalEntries += diff.entries.length;
  }

  return `# Diffs: ${totalEntries} total changes across ${diffs.length} resources\n\n${lines.join('\n')}`;
}

// ==========================================
// 内部实现
// ==========================================

/** 从 JSON 数组中提取所有存活节点，以 fileId 为 key */
function extractNodes(json: CocosObject[]): Map<string, NodeInfo> {
  const nodes = new Map<string, NodeInfo>();

  // 第一遍：建立 PrefabInfo index → fileId 的映射
  const prefabInfoMap = new Map<number, string>();
  for (let i = 0; i < json.length; i++) {
    const obj = json[i];
    if (!obj || obj.__deleted__) continue;
    if (obj.__type__ === 'cc.PrefabInfo' && obj.fileId) {
      prefabInfoMap.set(i, obj.fileId);
    }
  }

  // 第二遍：遍历 cc.Node，提取节点信息
  for (let i = 0; i < json.length; i++) {
    const obj = json[i];
    if (!obj || obj.__deleted__) continue;
    if (obj.__type__ !== 'cc.Node') continue;

    // 获取 node fileId
    const prefabId = obj._prefab?.__id__;
    const fileId = prefabId != null && prefabId < json.length
      ? (json[prefabId]?.fileId || `node_${i}`)
      : `node_${i}`;

    // 获取父节点 fileId
    const parentRefId = obj._parent?.__id__;
    let parentId: string | null = null;
    if (parentRefId != null && parentRefId >= 0 && parentRefId < json.length) {
      const parentNode = json[parentRefId];
      if (parentNode && !parentNode.__deleted__ && parentNode.__type__ === 'cc.Node') {
        const pPrefabId = parentNode._prefab?.__id__;
        parentId = pPrefabId != null && pPrefabId < json.length
          ? (json[pPrefabId]?.fileId || `node_${parentRefId}`)
          : `node_${parentRefId}`;
      }
    }

    // 提取组件
    const components: ComponentInfo[] = [];
    const compRefs = Array.isArray(obj._components) ? obj._components : [];
    for (const ref of compRefs) {
      const compIdx = ref.__id__;
      if (compIdx == null || compIdx < 0 || compIdx >= json.length) continue;
      const compObj = json[compIdx];
      if (!compObj || compObj.__deleted__ || !compObj.__type__) continue;
      if (compObj.__type__ === 'cc.PrefabInfo' || compObj.__type__ === 'cc.CompPrefabInfo') continue;

      // Component fileId
      const compPrefabRef = compObj.__prefab?.__id__;
      const compFileId = compPrefabRef != null && compPrefabRef < json.length
        ? (json[compPrefabRef]?.fileId || `comp_${compIdx}`)
        : `comp_${compIdx}`;

      // Props: skip system keys
      const props: Record<string, unknown> = {};
      for (const key of Object.keys(compObj)) {
        if (SKIP_KEYS.has(key)) continue;
        props[key] = safeValue((compObj as Record<string, unknown>)[key]);
      }

      components.push({
        fileId: compFileId,
        type: compObj.__type__,
        props,
      });
    }

    nodes.set(fileId, {
      fileId,
      name: obj._name || '',
      components,
      active: obj._active !== false,
      parentId,
    });
  }

  return nodes;
}

/** 比较两组属性，返回差异列表 */
function diffProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Array<{ key: string; before: unknown; after: unknown }> {
  const diffs: Array<{ key: string; before: unknown; after: unknown }> = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const bv = before[key];
    const av = after[key];

    if (bv === undefined && av !== undefined) {
      diffs.push({ key, before: undefined, after: av });
    } else if (bv !== undefined && av === undefined) {
      diffs.push({ key, before: bv, after: undefined });
    } else if (!valuesEqual(bv, av)) {
      diffs.push({ key, before: bv, after: av });
    }
  }

  return diffs;
}

/** 比较两个值是否相等（JSON 序列化比较，处理内联值类型） */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 安全提取值（将 __id__ / __uuid__ 引用保留为标记） */
function safeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(safeValue);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (obj.__id__ != null) return { __ref_id__: obj.__id__ };
    if (obj.__uuid__ != null) return { __ref_uuid__: obj.__uuid__ };
    try {
      return JSON.parse(JSON.stringify(val));
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/** 提取组件类型的简短名称 */
function shortType(fullType: string): string {
  if (fullType.startsWith('cc.')) return fullType.slice(3);
  return fullType;
}

/** 格式化值为可读字符串（控制长度） */
function formatVal(val: unknown): string {
  if (val === undefined) return 'undefined';
  if (val === null) return 'null';
  if (typeof val === 'string') {
    if (val.length > DIFF_VALUE_MAX) return `"${val.slice(0, DIFF_VALUE_MAX - 2)}..."`;
    return `"${val}"`;
  }
  if (typeof val === 'object') {
    const s = JSON.stringify(val);
    if (s.length > DIFF_OBJ_MAX) return s.slice(0, DIFF_OBJ_MAX - 2) + '...';
    return s;
  }
  return String(val);
}

/** 简易 groupBy */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}
