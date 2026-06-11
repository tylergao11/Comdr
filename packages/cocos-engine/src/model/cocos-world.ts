// ============================================================
// CocosWorld — Cocos Creator 世界模型的五个基础元素
// 全系统唯一真相源。每层都从这里引用类型，不做二次定义。
//
//   1. Asset      — 文件资源（UUID + 路径 + 类型 + 子资产）
//   2. Node       — 层级容器（fileId + 名称 + 父子关系 + 组件列表）
//   3. Component  — 类型化数据（ComponentIdentity + 属性表）
//   4. Value      — 属性值（原始类型 | 数学类型 | 引用 | 数组）
//   5. Reference  — 关系连线（__id__ 内部引 | __uuid__ 资产引）
//
// 核心洞察：__type__ 格式即身份
//   "cc.Sprite"         → 引擎组件，去 Catalog 查 schema/knowledge
//   "a1b2c3d4..."       → 自定义脚本（23位压缩UUID），去 Catalog 查类名
//   不需要外部查表就能区分！
// ============================================================

import { cloneJson } from '../foundation/value-kit.js';

// ============================================================
// 1. 值类型 — Cocos 数学结构，内嵌序列化，不分配 __id__
// ============================================================

export interface CocosVec2 { __type__: 'cc.Vec2'; x: number; y: number; }
export interface CocosVec3 { __type__: 'cc.Vec3'; x: number; y: number; z: number; }
export interface CocosVec4 { __type__: 'cc.Vec4'; x: number; y: number; z: number; w: number; }
export interface CocosSize { __type__: 'cc.Size'; width: number; height: number; }
export interface CocosColor { __type__: 'cc.Color'; r: number; g: number; b: number; a: number; }
export interface CocosQuat { __type__: 'cc.Quat'; x: number; y: number; z: number; w: number; }
export interface CocosRect { __type__: 'cc.Rect'; x: number; y: number; width: number; height: number; }

export type CocosMathType =
  | CocosVec2 | CocosVec3 | CocosVec4
  | CocosSize | CocosColor | CocosQuat | CocosRect;

// ============================================================
// 5. 引用 — 关系连线，Cocos JSON 的核心复杂度来源
// ============================================================

/** { __id__: number } — prefab 内部数组下标引用，Cocos 引擎基础件 */
export interface IdRef { __id__: number; }

/** { __uuid__: string } — 资产 UUID 引用，可选 __expectedType__ 提示 */
export interface UuidRef { __uuid__: string; __expectedType__?: string; }

export type CocosReference = IdRef | UuidRef;

// ============================================================
// 4. 值 — 属性的实际数据
// ============================================================

export type CocosPrimitive = string | number | boolean;
export interface CocosValueMap { [key: string]: CocosValue; }
export type CocosValue =
  | CocosPrimitive
  | CocosMathType
  | CocosReference
  | CocosValue[]
  | CocosValueMap
  | null;

// ============================================================
// 3. 组件 — 节点上的类型化数据
// ============================================================

/**
 * 组件身份 — 从 __type__ 字符串派生。
 * __type__ 格式本身就是引擎/脚本的天然分界，不需要外部查表。
 */
export interface ComponentIdentity {
  /** 'Sprite' 或 'testComdr' — 人类可读名 */
  name: string;
  /** 'cc' 为引擎组件，null 为自定义脚本 */
  namespace: string | null;
  /** true = 自定义脚本（__type__ 是压缩 UUID），false = 引擎组件 */
  isScript: boolean;
  /** Cocos JSON 中实际出现的 __type__ 字符串 */
  rawType: string;
}

/** 组件属性的 schema 字段 */
export interface PropertySchema {
  name: string;
  type: string;  // 'string'|'int'|'float'|'bool'|'vec2'|'vec3'|'vec4'|'size'|'color'|'quat'|'rect'|'node'|'component'|'asset'|'array'|'any'
  default?: unknown;
}

/** 运行时组件表示 */
export interface CocosComponent {
  identity: ComponentIdentity;
  properties: Record<string, CocosValue>;
  enabled: boolean;
  fileId?: string;  // CompPrefabInfo.fileId，编辑定位用
}

// ============================================================
// 2. 节点 — 场景图容器
// ============================================================

export interface CocosNode {
  fileId: string;
  name: string;
  parent: CocosNode | null;
  children: CocosNode[];
  components: CocosComponent[];
  active: boolean;
  position: CocosVec3;
  rotation: CocosVec3;   // Euler
  scale: CocosVec3;
  contentSize?: CocosSize;
  anchorPoint?: CocosVec2;
  layer: number;
}

// ============================================================
// 1. 资产 — 文件资源
// ============================================================

export interface CocosAsset {
  uuid: string;
  path: string;        // db://assets/...
  fsPath: string;      // 文件系统绝对路径
  importer: string;    // 'texture' | 'prefab' | 'typescript' | ...
  subAssets: CocosAsset[];
}

// ============================================================
// 创作类型 — Commander compile block → Assembler
// ============================================================

export interface NodeSpec {
  tempId: string;
  name: string;
  parent: string | null;
  prefab?: string;
  prefabUuid?: string;
  active?: boolean;
  position?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  contentSize?: { width: number; height: number };
  anchorPoint?: { x: number; y: number };
  components: ComponentSpec[];
  children?: NodeSpec[];
}

export interface ComponentSpec {
  type: string;  // "cc.Sprite" 或 "testComdr" — 由 Catalog.resolve() 标准化
  props: Record<string, unknown>;
}

export interface CompileSpec {
  path?: string;
  name?: string;
  nodes: NodeSpec[];
}

// ============================================================
// 序列化类型 — Cocos prefab JSON 扁平数组格式
// ============================================================

export interface SerializedComponent {
  __type__: string;
  _name: string;
  _objFlags: number;
  node: IdRef;
  _enabled: boolean;
  _id: string;
  __prefab?: IdRef;  // → CompPrefabInfo
  [key: string]: unknown;
}

export interface SerializedNode {
  __type__: 'cc.Node';
  _name: string;
  _objFlags: number;
  _parent: IdRef | null;
  _children: IdRef[];
  _components: IdRef[];
  _prefab: IdRef;     // → PrefabInfo
  _active: boolean;
  _lpos: CocosVec3;
  _lrot: CocosQuat;
  _lscale: CocosVec3;
  _euler: CocosVec3;
  _layer: number;
  _id: string;
  _contentSize?: CocosSize;
  _anchorPoint?: CocosVec2;
  [key: string]: unknown;
}

export interface SerializedPrefab {
  __type__: 'cc.Prefab';
  _name: string;
  _objFlags: number;
  data: IdRef;  // → root node
  [key: string]: unknown;
}

export interface SerializedPrefabInfo {
  __type__: 'cc.PrefabInfo';
  root: IdRef | null;
  asset: IdRef | UuidRef | null;
  fileId: string;
  instance?: IdRef;
  nestedPrefabInstanceRoots?: IdRef[];
  [key: string]: unknown;
}

export interface SerializedCompPrefabInfo {
  __type__: 'cc.CompPrefabInfo';
  fileId: string;
  [key: string]: unknown;
}

export type SerializedObject = Record<string, unknown>;
export type PrefabJson = SerializedObject[];

// ============================================================
// 构建期类型 — 组装管线内部使用
// ============================================================

/** 构建期 Node — 持有实体引用，normalizeRefs 后转为 IdRef */
export interface BuiltNode {
  __type__: 'cc.Node';
  __id__: number;
  _name: string;
  _objFlags: number;
  _parent: BuiltNode | null;
  _children: BuiltNode[];
  _components: SerializedComponent[];
  _prefab: SerializedPrefabInfo;
  _active: boolean;
  _lpos: CocosVec3;
  _lrot: CocosQuat;
  _lscale: CocosVec3;
  _euler: CocosVec3;
  _layer: number;
  _id: string;
  _contentSize?: CocosSize;
  _anchorPoint?: CocosVec2;
  tempId: string;
  _comdr_tempId?: string;
  _nestedSource?: string;
  _nestedRoot?: BuiltNode;
  _prefabInstance?: SerializedObject;
  [key: string]: unknown;
}

/** 构建期 Prefab 包装器 */
export interface BuiltPrefab {
  __type__: 'cc.Prefab';
  __id__: number;
  _name: string;
  _objFlags: number;
  data: BuiltNode | IdRef;
  [key: string]: unknown;
}

// ============================================================
// 模板常量
// ============================================================

export const VALUE_TYPE_TEMPLATES: Record<string, Record<string, unknown>> = {
  'cc.Vec2':  { __type__: 'cc.Vec2',  x: 0, y: 0 },
  'cc.Vec3':  { __type__: 'cc.Vec3',  x: 0, y: 0, z: 0 },
  'cc.Vec4':  { __type__: 'cc.Vec4',  x: 0, y: 0, z: 0, w: 0 },
  'cc.Size':  { __type__: 'cc.Size',  width: 100, height: 100 },
  'cc.Color': { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
  'cc.Quat':  { __type__: 'cc.Quat',  x: 0, y: 0, z: 0, w: 1 },
  'cc.Rect':  { __type__: 'cc.Rect',  x: 0, y: 0, width: 0, height: 0 },
};

/** 值类型名称集合 — 内嵌序列化，不分配 __id__ */
export const VALUE_TYPE_NAMES: ReadonlySet<string> = new Set(Object.keys(VALUE_TYPE_TEMPLATES));

/** 非用户组件的引擎基础设施类型 */
const INFRA_TYPES = new Set([
  'cc.Node', 'cc.Prefab', 'cc.Scene', 'cc.SceneAsset',
  'cc.PrefabInfo', 'cc.CompPrefabInfo', 'cc.PrefabInstance',
  'cc.TargetInfo', 'CCPropertyOverrideInfo', 'cc.ClickEvent',
]);

/** 层级节点类型 — cc.Node 和 cc.Scene 在树结构中行为一致 */
export const NODE_LIKE_TYPES: ReadonlySet<string> = new Set(['cc.Node', 'cc.Scene']);

export const NODE_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.Node',
  _name: '',
  _objFlags: 0,
  _parent: null,
  _children: [],
  _active: true,
  _components: [],
  _prefab: null,
  _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
  _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
  _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 },
  _layer: 1 << 25, // UI_2D (Cocos built-in layer mask = 33554432)
  _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
  _id: '',
};

export const PREFAB_WRAPPER_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.Prefab',
  _name: '',
  _objFlags: 0,
  _native: '',
  data: null,
  optimizationPolicy: 0,
  asyncLoadAssets: false,
  persistent: false,
};

export const PREFAB_INFO_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.PrefabInfo',
  root: null,
  asset: null,
  fileId: '',
};

export const COMP_PREFAB_INFO_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.CompPrefabInfo',
  fileId: '',
};

export const PREFAB_INSTANCE_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.PrefabInstance',
  fileId: '',
  prefabRootNode: null,
  mountedChildren: [],
  mountedComponents: [],
  propertyOverrides: [],
  removedComponents: [],
};

export const TARGET_INFO_TEMPLATE: Record<string, unknown> = {
  __type__: 'cc.TargetInfo',
  localID: [],
};

export const PROPERTY_OVERRIDE_INFO_TEMPLATE: Record<string, unknown> = {
  __type__: 'CCPropertyOverrideInfo',
  targetInfo: null,
  propertyPath: [],
  value: null,
};

// ============================================================
// 组件模板生成
// ============================================================

/** 从 schema 字段列表生成组件 JSON 模板 */
export function generateComponentTemplate(
  rawType: string,
  fields: PropertySchema[],
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    __type__: rawType,
    _name: '',
    _objFlags: 0,
    node: null,
    _enabled: true,
    _id: '',
  };

  const skipKeys = new Set([
    '_name', '_enabled', 'enabled', '_id', 'id',
    '_objFlags', 'objFlags', '__editorExtras__', 'node',
  ]);

  for (const field of fields) {
    if (skipKeys.has(field.name)) continue;
    // Cocos 序列化用 _ 前缀，已带 _ 的不再加
    const key = field.name.startsWith('_') ? field.name : '_' + field.name;
    template[key] = defaultValueForSchemaType(field.type);
  }

  // 合成 _contentSize（如有 _width/_height 字段 — schema 使用下划线前缀命名）
  if ('_width' in template || '_height' in template) {
    const sz = { ...cloneJson(VALUE_TYPE_TEMPLATES['cc.Size']) };
    if (template._width !== undefined) (sz as Record<string, unknown>).width = template._width;
    if (template._height !== undefined) (sz as Record<string, unknown>).height = template._height;
    delete template._width;
    delete template._height;
    template._contentSize = sz;
  }
  // 合成 _anchorPoint
  if ('_anchorX' in template || '_anchorY' in template) {
    const ap = { ...cloneJson(VALUE_TYPE_TEMPLATES['cc.Vec2']) };
    if (template._anchorX !== undefined) (ap as Record<string, unknown>).x = template._anchorX;
    if (template._anchorY !== undefined) (ap as Record<string, unknown>).y = template._anchorY;
    delete template._anchorX;
    delete template._anchorY;
    template._anchorPoint = ap;
  }

  return template;
}

function defaultValueForSchemaType(type: string): unknown {
  switch (type) {
    case 'string': return '';
    case 'int': case 'float': case 'number': return 0;
    case 'bool': case 'boolean': return false;
    case 'color': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Color']);
    case 'vec2': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Vec2']);
    case 'vec3': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Vec3']);
    case 'vec4': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Vec4']);
    case 'size': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Size']);
    case 'rect': return cloneJson(VALUE_TYPE_TEMPLATES['cc.Rect']);
    case 'node': case 'component': case 'asset': return null;
    case 'array': return [];
    default: return 0; // 'any' → 0，确保字段存在
  }
}

/** 最小组件模板（无 schema 时使用，如自定义脚本） */
export function minimalComponentTemplate(rawType: string): Record<string, unknown> {
  return {
    __type__: rawType,
    _name: '',
    _objFlags: 0,
    node: null,
    _enabled: true,
    _id: '',
  };
}

// ============================================================
// __type__ 格式判断工具
// ============================================================

/** 压缩 UUID：22-23 字符，base64 变体（Cocos compressed UUID 格式） */
const COMPRESSED_UUID_RE = /^[0-9a-zA-Z+/]{22,23}$/;

/** 判断 __type__ 字符串是否是压缩 UUID（→ 自定义脚本） */
export function isCompressedUuidType(typeName: string): boolean {
  if (!typeName || typeName.startsWith('cc.')) return false;
  return COMPRESSED_UUID_RE.test(typeName);
}

/** 判断 __type__ 字符串是否是值类型（内嵌序列化，不分配 __id__） */
export function isValueType(typeName: string): boolean {
  return VALUE_TYPE_NAMES.has(typeName);
}

/** 判断 __type__ 是否是引擎基础设施类型（Node/Prefab/PrefabInfo 等） */
export function isInfraType(typeName: string): boolean {
  return INFRA_TYPES.has(typeName);
}

/** 判断 __type__ 是否是用户可见的引擎组件（cc.Xxx，排除基础设施和值类型） */
export function isEngineComponentType(typeName: string): boolean {
  return typeName.startsWith('cc.') && !isValueType(typeName) && !isInfraType(typeName);
}

/** 从 __type__ 解析 ComponentIdentity。
 *  @param rawType    Cocos JSON 中的 __type__ 值
 *  @param classNameLookup  压缩 UUID → @ccclass 类名（可选，ScriptRegistry 提供） */
export function parseComponentIdentity(
  rawType: string,
  classNameLookup?: (compressedId: string) => string,
): ComponentIdentity {
  if (isCompressedUuidType(rawType)) {
    const name = classNameLookup ? classNameLookup(rawType) : rawType;
    return { name: name || rawType, namespace: null, isScript: true, rawType };
  }
  if (rawType.startsWith('cc.')) {
    const name = rawType.slice(3); // 去掉 'cc.' 前缀
    return { name, namespace: 'cc', isScript: false, rawType };
  }
  // 未知格式—按脚本类名处理
  return { name: rawType, namespace: null, isScript: true, rawType };
}

// ============================================================
// 组装结果 & 统计
// ============================================================

export interface AssemblyStats {
  nodes: number;
  components: number;
  totalObjects: number;
}

export type AssemblerResult =
  | { ok: true; json: unknown[]; stats: AssemblyStats }
  | { ok: false; error: string; errorCode: string };

// ============================================================
// 引用解析器接口
// ============================================================

export interface RefResolver {
  isNodeRef(componentType: string, propName: string): boolean;
  isComponentRef(componentType: string, propName: string): string | null;
  isAssetRef(componentType: string, propName: string): boolean;
}

export const NOOP_RESOLVER: RefResolver = {
  isNodeRef: () => false,
  isComponentRef: () => null,
  isAssetRef: () => false,
};

// ============================================================
// 资产类型推断 — 属性名后缀 → Cocos 资产类型（单一真实源）
// ============================================================

/**
 * 属性名 → 资产类型 映射表。单一真实源，serialize + asset-resolver 共用。
 * 每条规则：{ pattern: (cleanProp) => boolean, type: cocosTypeName }
 * 优先级：精确匹配 > 后缀匹配（按表顺序）
 */
const ASSET_TYPE_RULES: ReadonlyArray<{ test: (clean: string) => boolean; type: string }> = [
  { test: (c) => c === 'sprite',                          type: 'cc.SpriteFrame' },
  { test: (c) => c.endsWith('spriteFrame'),               type: 'cc.SpriteFrame' },
  { test: (c) => c.endsWith('spriteAtlas'),               type: 'cc.SpriteAtlas' },
  { test: (c) => c === 'atlas',                           type: 'cc.SpriteAtlas' },
  { test: (c) => c.endsWith('Material'),                  type: 'cc.Material' },
  { test: (c) => c.endsWith('Font'),                      type: 'cc.TTFFont' },
  { test: (c) => c.endsWith('Texture'),                   type: 'cc.Texture2D' },
];

/** 根据属性名推断 Cocos 资产类型（去掉前导 _ 后匹配） */
export function guessAssetType(propName: string): string | undefined {
  const clean = propName.replace(/^_/, '');
  for (const rule of ASSET_TYPE_RULES) {
    if (rule.test(clean)) return rule.type;
  }
  return undefined;
}
