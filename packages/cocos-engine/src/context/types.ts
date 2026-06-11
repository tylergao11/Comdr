// ============================================================
// Context Types — Blueprint Pattern 类型定义
// CompiledContext 是 LLM 看到的蓝图，不包含任何 Cocos 内部格式
// ============================================================

// ===== 编译后组件属性 =====

/** 编译后的属性 — 仅限 DSL 可操作的关键属性 */
export interface CompiledProperty {
  /** DSL set-prop 的 property 参数 */
  name: string;
  /** Schema type: 'string'|'bool'|'number'|'color'|'vec2'|... */
  type: string;
  /** 默认值 */
  default?: unknown;
}

/** 编译后的引用属性 — 含已解析的目标描述 */
export interface CompiledRefProperty {
  /** 属性名 */
  name: string;
  /** 引用类型 */
  refType: 'node' | 'component' | 'asset';
  /** 当前绑定的目标描述（人类可读） */
  target?: string;
  /** 目标的 DSL 可用标识符（fileId / assetPath 等） */
  targetId?: string;
}

// ===== 编译后 Schema =====

/** Knowledge 子组件定义 */
export interface CompiledKnowledgeChild {
  /** 子组件类型 */
  type: string;
  /** 是否可选 */
  optional?: boolean;
  /** 默认属性 */
  props?: Record<string, unknown>;
  /** 递归子节点 */
  children?: CompiledKnowledgeChild[];
}

/** 编译后的组件 Schema — CAG 输出 */
export interface CompiledSchema {
  /** 组件类型名 "cc.Button" */
  type: string;
  /** 人类可读描述 */
  description?: string;
  /** 是否为脚本 */
  isScript?: boolean;

  /** 关键属性（DSL 常用操作） */
  keyProperties: CompiledProperty[];
  /** 引用属性（已解析当前绑定） */
  refProperties?: CompiledRefProperty[];
  /** 属性总数 */
  totalProperties: number;

  // Knowledge 约束
  requires?: string[];
  conflicts?: string[];
  children?: CompiledKnowledgeChild[];
}

// ===== 编译后场景树 =====

/** 编译后的组件摘要 — 只含关键属性当前值 */
export interface CompiledComponentSummary {
  /** 组件类型 "cc.Button" */
  type: string;
  /** 关键属性的当前值 */
  keyProps: Record<string, unknown>;
  /** 已解析的引用属性 */
  refProps?: CompiledRefProperty[];
}

/** 编译后的节点 — 场景树中的一行 */
export interface CompiledNode {
  /** DSL 直接引用的 fileId */
  fileId: string;
  /** 节点名 */
  name: string;
  /** 层级深度（格式化用） */
  depth: number;
  /** 从根到该节点的路径 "/MainMenu/Panel/StartBtn" */
  path: string;
  /** 组件摘要列表 */
  components: CompiledComponentSummary[];
  /** 子节点 */
  children: CompiledNode[];
  /** knowledge 自动创建标记 */
  autoCreated?: boolean;
}

// ===== 资源列表 =====

/** 编译后的资源条目 */
export interface CompiledAssetEntry {
  /** 资源名 */
  name: string;
  /** assets/ 相对路径 */
  path: string;
  /** 是否为目录 */
  isDir: boolean;
  /** 资源类型 */
  importer?: string;
}

// ===== 可插入位置 =====

/** 可插入位置 */
export interface CompiledInsertionPoint {
  /** parent fileId — DSL add-node 直接使用 */
  parent: string;
  /** 节点名 */
  name: string;
  /** 推荐级别 */
  rank: 'recommended' | 'usable' | 'limited';
  /** 约束描述 */
  description: string;
  /** 当前子节点名 */
  currentChildren: string[];
}

// ===== 编译上下文 =====

/** 编译上下文 — LLM 的蓝图 */
export interface CompiledContext {
  schema: 'Comdr.compiled-context.v1';

  /** 当前文档信息 */
  document?: {
    kind: 'prefab' | 'scene';
    path: string;
    name: string;
    rootFileId?: string;
  };

  /** 场景层级树 */
  tree?: CompiledNode;

  /** CAG 注入的组件 schema */
  schemas: CompiledSchema[];

  /** 可用资源列表 */
  assets?: CompiledAssetEntry[];

  /** 脚本列表 */
  scripts?: Array<{ name: string; path: string; compressedId: string }>;

  /** 可插入位置分析 */
  insertionPoints?: CompiledInsertionPoint[];

  /** 检索摘要 */
  summary: string;

  /** 警告（部分失败时） */
  warnings?: string[];
}

// ===== Retrieve 命令参数 =====

/** 探针规格 */
export interface ProbeSpec {
  kind: string;
  path?: string;
  fileId?: string;
  name?: string;
  pattern?: string;
  componentType?: string;
  property?: string;
  depth?: number | 'all';
  detail?: 'structure' | 'full';
  [key: string]: unknown;
}

/** 编译选项 */
export interface CompileOptions {
  /** 组件目录 */
  catalog: unknown; // ComponentCatalog — 避免循环依赖，实际实现时 import
  /** 内部资源目录 */
  internalCatalog: unknown; // InternalAssetCatalog
  /** 资源缓存 */
  assetCache?: unknown; // AssetCache — 可选，有则解析 uuid→path
  /** 编译提示 */
  hints?: string;
}
