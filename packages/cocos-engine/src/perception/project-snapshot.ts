// ============================================================
// ProjectSnapshot — 项目感知数据模型 + 收集
// ============================================================

export interface NodeEntry {
  name: string;
  fileId: string;
  components: string[];
  children: NodeEntry[];
}

export interface PrefabEntry {
  path: string;
  rootName: string;
}

export interface SceneEntry {
  path: string;
}

export interface ScriptEntry {
  className: string;
  path: string;
}

export interface ResourceEntry {
  path: string;
  uuid: string;
  type: string;
}

export interface ProjectSnapshot {
  openDocument: {
    kind: 'prefab' | 'scene' | 'none';
    path: string;
    nodes: NodeEntry[];
  };
  prefabs: PrefabEntry[];
  scenes: SceneEntry[];
  scripts: ScriptEntry[];
  resources: ResourceEntry[];
  collectedAt: string;
}

export const EMPTY_SNAPSHOT: ProjectSnapshot = {
  openDocument: { kind: 'none', path: '', nodes: [] },
  prefabs: [],
  scenes: [],
  scripts: [],
  resources: [],
  collectedAt: '',
};

// ===== 从 Bridge probe 结果构建 Snapshot =====

/** 从 assets probe 结果提取 prefab/scene/resource 列表 */
export function buildFromAssetsProbe(data: unknown): {
  prefabs: PrefabEntry[];
  scenes: SceneEntry[];
  resources: ResourceEntry[];
} {
  const prefabs: PrefabEntry[] = [];
  const scenes: SceneEntry[] = [];
  const resources: ResourceEntry[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const assetPath = (rec.path || rec.url || '') as string;
      const uuid = (rec.uuid || '') as string;
      const type = (rec.type || '') as string;

      if (assetPath.endsWith('.prefab')) {
        prefabs.push({ path: assetPath, rootName: (rec.name as string) || '' });
      } else if (assetPath.endsWith('.scene') || type === 'scene') {
        scenes.push({ path: assetPath });
      } else if (uuid && assetPath) {
        resources.push({ path: assetPath, uuid, type });
      }
    }
  }

  return { prefabs, scenes, resources };
}

/** 从 scripts probe 结果提取脚本列表 */
export function buildFromScriptsProbe(data: unknown): ScriptEntry[] {
  const scripts: ScriptEntry[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      scripts.push({
        className: (rec.className || rec.name || '') as string,
        path: (rec.path || rec.url || '') as string,
      });
    }
  }
  return scripts;
}

/** 从 ctx() probe 结果的字符串摘要解析节点信息（受限于 Commander 返回的摘要文本） */
export function buildNodeEntriesFromCtx(data: unknown): NodeEntry[] {
  // ctx() 返回的是节点树摘要文本，格式不定。这里提供一个基础解析器。
  // 如果 data 是对象（有 _children），直接递归解析
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    return [parseNodeTree(rec)];
  }
  return [];
}

function parseNodeTree(node: Record<string, unknown>): NodeEntry {
  const components: string[] = [];
  const comps = node._components as unknown[];
  if (Array.isArray(comps)) {
    for (const c of comps) {
      if (c && typeof c === 'object') {
        const compType = (c as Record<string, unknown>).__type__ as string;
        if (compType) components.push(compType);
      }
    }
  }

  const children: NodeEntry[] = [];
  const childNodes = node._children as unknown[];
  if (Array.isArray(childNodes)) {
    for (const c of childNodes) {
      if (c && typeof c === 'object') {
        children.push(parseNodeTree(c as Record<string, unknown>));
      }
    }
  }

  return {
    name: (node._name as string) || '',
    fileId: (node._id as string) || '',
    components,
    children,
  };
}

/** 在节点树中递归搜索匹配名字的节点 */
export function findNodeByName(nodes: NodeEntry[], name: string): NodeEntry | null {
  const lower = name.toLowerCase();
  for (const node of nodes) {
    if (node.name.toLowerCase() === lower) return node;
    const found = findNodeByName(node.children, name);
    if (found) return found;
  }
  return null;
}

/** 在节点树中收集所有节点名（扁平列表） */
export function collectNodeNames(nodes: NodeEntry[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    names.push(node.name);
    names.push(...collectNodeNames(node.children));
  }
  return names;
}
