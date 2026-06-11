// ============================================================
// ComponentCatalog — 统一组件目录
// 合并旧 COMPONENT_REGISTRY + ScriptRegistry + KnowledgeBase
// 引擎组件和自定义脚本的查询接口完全一致
//
// 数据来源：
//   1. component-cache.json — 引擎组件 schema（Bridge 从引擎 TS 源码提取）
//   2. resource-index.json  — 用户脚本列表（Bridge 从编辑器提取）
//   3. component-knowledge.json — 组件结构约束和默认值（手写）
// ============================================================

import * as path from 'path';
import { readJsonUtf8, normalizeSlash, levenshtein } from '../foundation/value-kit.js';
import { getKnowledgeData } from '../knowledge/knowledge-data.js';
import {
  ComponentIdentity,
  PropertySchema,
  generateComponentTemplate,
  minimalComponentTemplate,
  parseComponentIdentity,
  isCompressedUuidType,
} from './cocos-world.js';

// ============================================================
// 目录条目 — engine 组件和用户脚本共享此接口
// ============================================================

export interface KnowledgeChildComponent {
  type: string;
  optional?: boolean;
  props?: Record<string, unknown>;
}

export interface KnowledgeChildNode {
  id: string;
  name: string;
  required: boolean;
  autoCreateCondition?: string;
  parent?: string;
  components: KnowledgeChildComponent[];
  children?: KnowledgeChildNode[];
}

export interface KnowledgeRef {
  targetType: 'node' | 'component';
  targetChild?: string;
  componentType?: string;
  optional?: boolean;
}

export interface ComponentKnowledge {
  description?: string;
  autoAdd?: boolean;
  autoAddCondition?: string;
  requires?: string[];        // 同节点必需的其他组件
  conflicts?: string[];       // 互斥组件
  constraint?: string;
  children?: KnowledgeChildNode[];  // 自动创建子节点结构
  refs?: Record<string, KnowledgeRef>;  // 跨节点引用配置
  defaults?: Record<string, unknown>;  // 属性默认值
}

export interface ComponentEntry {
  identity: ComponentIdentity;
  schema: PropertySchema[];        // 属性 schema（engine 有完整类型，script 只有名称）
  knowledge: ComponentKnowledge | null;
  template: Record<string, unknown>;  // 生成的 JSON 模板
}

// ============================================================
// 内部数据结构
// ============================================================

interface CacheFileSchema {
  schema: string;
  source: string;
  components: Record<string, { properties: Record<string, { type: string; default?: unknown }> }>;
}

interface ResourceIndexFile {
  scripts?: Array<{
    name: string;
    path: string;
    compressedId: string;
    methods?: string[];
    properties?: string[];
  }>;
}

// ============================================================
// Catalog 实现
// ============================================================

export class ComponentCatalog {
  /** 规范类型名 → 条目 */
  private _entries: Map<string, ComponentEntry> = new Map();
  /** 类名 → 规范名（Sprite → cc.Sprite, testComdr → compressedUuid） */
  private _nameIndex: Map<string, string> = new Map();
  /** 压缩 UUID → 规范名（反向查脚本） */
  private _uuidIndex: Map<string, string> = new Map();
  private _loaded = false;

  // ===== 加载 =====

  /** 一次性加载所有组件数据 */
  load(projectPath: string): number {
    const root = normalizeSlash(projectPath);
    const tempDir = path.join(root, 'temp', 'comdr');
    let count = 0;

    // 1. 加载引擎组件 schema（component-cache.json）
    const cachePath = path.join(tempDir, 'component-cache.json');
    const cacheData = readJsonUtf8(cachePath) as CacheFileSchema | null;
    if (cacheData?.components) {
      for (const [typeName, comp] of Object.entries(cacheData.components)) {
        const fields: PropertySchema[] = Object.entries(comp.properties).map(
          ([name, prop]) => ({ name, type: prop.type, default: prop.default }),
        );
        const identity = parseComponentIdentity(typeName);
        const template = generateComponentTemplate(typeName, fields);
        const entry: ComponentEntry = {
          identity,
          schema: fields,
          knowledge: null, // 后面从 knowledge 文件合并
          template,
        };
        this._entries.set(typeName, entry);
        this._nameIndex.set(typeName.toLowerCase().replace(/^cc\./, ''), typeName);
        this._nameIndex.set(typeName.toLowerCase(), typeName);
        count++;
      }
    }

    // 2. 加载用户脚本（resource-index.json）
    const resourcePath = path.join(tempDir, 'resource-index.json');
    const resourceData = readJsonUtf8(resourcePath) as ResourceIndexFile | null;
    if (resourceData?.scripts) {
      for (const s of resourceData.scripts) {
        if (!s.name || !s.compressedId) continue;
        const identity = parseComponentIdentity(s.compressedId, () => s.name);
        // 脚本的 schema：只有属性名，类型都是 'any'
        const schema: PropertySchema[] = (s.properties || []).map((p) => ({
          name: p,
          type: 'any',
        }));
        const template = minimalComponentTemplate(s.compressedId);
        const entry: ComponentEntry = {
          identity,
          schema,
          knowledge: null,
          template,
        };
        this._entries.set(s.compressedId, entry);
        // 防止脚本类名覆盖引擎组件：如脚本名为 "Sprite" 不应遮蔽 cc.Sprite
        const engineKey = s.name.toLowerCase();
        const engineConflict = this._nameIndex.get(engineKey);
        if (engineConflict && engineConflict.startsWith('cc.')) {
          process.stderr.write(`[comdr] WARNING: Script "${s.name}" shadows engine component "${engineConflict}". Use compressed UUID or full class name to disambiguate.\n`);
        } else {
          this._nameIndex.set(s.name, s.compressedId);
          this._nameIndex.set(engineKey, s.compressedId);
        }
        this._uuidIndex.set(s.compressedId, s.compressedId);
        // path-based lookup (for compressed UUID lookup by path)
        if (s.path) {
          this._nameIndex.set(normalizeSlash(s.path), s.compressedId);
        }
        count++;
      }
    }

    // 3. 加载组件知识库（编译时内嵌，运行时零文件依赖）
    const knowledgeData = getKnowledgeData();
    if (knowledgeData && Object.keys(knowledgeData).length > 0) {
      for (const [typeName, k] of Object.entries(knowledgeData)) {
        const entry = this._entries.get(typeName);
        if (entry) {
          entry.knowledge = k;
          // 知识库的 defaults 合并到模板
          if (k.defaults) {
            for (const [key, value] of Object.entries(k.defaults)) {
              const underscored = key.startsWith('_') ? key : '_' + key;
              if (!(underscored in entry.template)) {
                entry.template[underscored] = value;
              }
            }
          }
        } else {
          // knowledge 中提到了但 schema cache 中没有的组件：创建最小条目
          const identity = parseComponentIdentity(typeName);
          const entry: ComponentEntry = {
            identity,
            schema: [],
            knowledge: k,
            template: minimalComponentTemplate(typeName),
          };
          this._entries.set(typeName, entry);
          this._nameIndex.set(typeName.toLowerCase().replace(/^cc\./, ''), typeName);
          this._nameIndex.set(typeName.toLowerCase(), typeName);
        }
      }
    }

    this._loaded = true;
    return count;
  }

  /** 重新加载 */
  reload(projectPath: string): void {
    this._entries.clear();
    this._nameIndex.clear();
    this._uuidIndex.clear();
    this._loaded = false;
    this.load(projectPath);
  }

  get isLoaded(): boolean {
    return this._loaded;
  }

  // ===== 查询 =====

  /** 获取单个组件条目（接受类名、cc.Xxx 全名、或压缩 UUID） */
  get(typeName: string): ComponentEntry | null {
    // 直接命中
    if (this._entries.has(typeName)) {
      return this._entries.get(typeName)!;
    }
    // 通过 name index 查找
    const canonical = this._nameIndex.get(typeName)
      || this._nameIndex.get(typeName.toLowerCase())
      || this._uuidIndex.get(typeName);
    if (canonical) {
      return this._entries.get(canonical) || null;
    }
    return null;
  }

  /** 解析类型名为规范形式。
   *   "Sprite"      → "cc.Sprite"
   *   "cc.Sprite"   → "cc.Sprite"
   *   "testComdr"   → "a1b2c3d4..."（压缩 UUID）
   *   "a1b2c3d4..." → "a1b2c3d4..."（已是压缩 UUID，验证后返回） */
  resolve(typeName: string): string {
    if (!typeName) return typeName;
    // 已是规范引擎组件名
    if (this._entries.has(typeName)) return typeName;
    // 压缩 UUID → 验证
    if (isCompressedUuidType(typeName) && this._uuidIndex.has(typeName)) {
      return typeName;
    }
    // 类名/短名 → 查找
    const canonical = this._nameIndex.get(typeName)
      || this._nameIndex.get(typeName.toLowerCase())
      || (typeName.startsWith('cc.') ? null : this._nameIndex.get(`cc.${typeName}`));
    return canonical || typeName;
  }

  /** 获取组件身份 */
  identityOf(typeName: string): ComponentIdentity | null {
    const entry = this.get(typeName);
    return entry?.identity || null;
  }

  /** 获取属性 schema */
  schemaOf(typeName: string): PropertySchema[] {
    const entry = this.get(typeName);
    return entry?.schema || [];
  }

  /** 获取 JSON 模板 */
  templateOf(typeName: string): Record<string, unknown> | null {
    const entry = this.get(typeName);
    return entry?.template || null;
  }

  /** 获取组件知识 */
  knowledgeOf(typeName: string): ComponentKnowledge | null {
    const entry = this.get(typeName);
    return entry?.knowledge || null;
  }

  /** 通过压缩 UUID 查类名 */
  classNameOf(compressedId: string): string {
    const entry = this._entries.get(compressedId);
    return entry?.identity.name || '';
  }

  /** 通过类名查压缩 UUID */
  compressedIdOf(className: string): string {
    const canonical = this._nameIndex.get(className) || this._nameIndex.get(className.toLowerCase());
    if (canonical && isCompressedUuidType(canonical)) return canonical;
    return '';
  }

  /** 列出所有组件类型名 */
  list(): string[] {
    return [...this._entries.keys()].sort();
  }

  /** 列出所有脚本组件 */
  listScripts(): ComponentEntry[] {
    return [...this._entries.values()].filter((e) => e.identity.isScript);
  }

  /** 列出所有引擎组件 */
  listEngine(): ComponentEntry[] {
    return [...this._entries.values()].filter((e) => !e.identity.isScript);
  }

  /** 模糊搜索组件 — 返回所有匹配项（按距离排序）。供 Gateway 判断歧义。 */
  fuzzyFindAll(pattern: string): string[] {
    const lower = pattern.toLowerCase().replace(/^cc\./, '');
    const candidates = [...this._entries.keys()];

    // 精确匹配（不分大小写）
    const exact = candidates.find(
      (t) => t.toLowerCase() === `cc.${lower}` || t.toLowerCase().replace('cc.', '') === lower,
    );
    if (exact) return [exact];

    const viaIndex = this._nameIndex.get(lower) || this._nameIndex.get(`cc.${lower}`);
    if (viaIndex) return [viaIndex];

    // Levenshtein ≤ 2，按距离排序
    const matches: Array<{ type: string; dist: number }> = [];
    for (const t of candidates) {
      const bare = t.replace('cc.', '').toLowerCase();
      const dist = levenshtein(lower, bare, 2);
      if (dist <= 2) matches.push({ type: t, dist });
    }
    matches.sort((a, b) => a.dist - b.dist);
    return matches.map((m) => m.type);
  }

  /** 模糊搜索组件（Levenshtein 距离 ≤ 2）— 返回单个最佳匹配 */
  fuzzyFind(pattern: string): string | null {
    const all = this.fuzzyFindAll(pattern);
    return all.length > 0 ? all[0] : null;
  }

  /** 检查两个组件类型是否冲突 */
  hasConflict(typeA: string, typeB: string): boolean {
    const kA = this.knowledgeOf(typeA);
    const kB = this.knowledgeOf(typeB);
    if (kA?.conflicts?.includes(typeB)) return true;
    if (kB?.conflicts?.includes(typeA)) return true;
    return false;
  }

  /** 获取组件的必需依赖（同节点其他组件） */
  getRequiredComponents(typeName: string): string[] {
    return this.knowledgeOf(typeName)?.requires || [];
  }

  /** 获取组件属性的知识库默认值 */
  getKnowledgeDefaults(typeName: string): Record<string, unknown> {
    return (this.knowledgeOf(typeName)?.defaults || {}) as Record<string, unknown>;
  }

  get count(): number {
    return this._entries.size;
  }
}

// ===== RefResolver 实现 =====

import { RefResolver } from './cocos-world.js';

/** 基于 Catalog schema 的引用解析器 */
export function createRefResolver(catalog: ComponentCatalog): RefResolver {
  return {
    isNodeRef(compType: string, propName: string): boolean {
      const entry = catalog.get(compType);
      if (!entry) return false;
      const field = entry.schema.find((f) => f.name === propName || f.name === `_${propName}`);
      return field?.type === 'node';
    },
    isComponentRef(compType: string, propName: string): string | null {
      const entry = catalog.get(compType);
      if (!entry) return null;
      const field = entry.schema.find((f) => f.name === propName || f.name === `_${propName}`);
      return field?.type === 'component' ? 'cc.Component' : null;
    },
    isAssetRef(compType: string, propName: string): boolean {
      const entry = catalog.get(compType);
      if (!entry) return false;
      const field = entry.schema.find((f) => f.name === propName || f.name === `_${propName}`);
      return field?.type === 'asset';
    },
  };
}
