// ============================================================
// @comdr/core — 全系统共享类型（编排层类型）
// 注意：Cocos 世界模型类型（CompileSpec/NodeSpec/ComponentSpec 等）
// 统一定义在 model/cocos-world.ts，此处不再重复定义。
// ============================================================

import type { CompileSpec, NodeSpec, ComponentSpec, AssemblerResult } from './model/cocos-world.js';
import type { PrefabDiffResult } from './perception/prefab-diff.js';
// 重新导出世界模型类型（单一真相源）
export type { CompileSpec, NodeSpec, ComponentSpec, AssemblerResult };

// ----- Result 容器 -----

/** 成功结果，所有操作统一此格式 */
export interface OkResult<T = unknown> {
  ok: true;
  data?: T;
  [key: string]: unknown;
}

/** 失败结果，每个错误必定有 errorCode */
export interface ErrResult {
  ok: false;
  error: string;
  errorCode: string;
  needMoreContext?: boolean;
  fatal?: boolean;
  notes?: NoteEntry[];
}

export type Result<T = unknown> = OkResult<T> | ErrResult;

// ----- 笔记/注释 -----

export interface NoteEntry {
  kind: 'guess' | 'warn';
  text: string;
}

// ----- 命令执行结果 -----

export interface CmdResult {
  ok: boolean;
  type?: string;
  data?: unknown;
  error?: string;
  errorCode?: string;
  needMoreContext?: boolean;
  notes?: NoteEntry[];
  fatal?: boolean;
  /** Gateway 本地修正记录（不浪费 LLM 轮次） */
  autoCorrected?: { from: string; to: string };
}

// ============================================================
// DSL 命令类型 — 可区分联合
// ============================================================

/** 完整的 DSL 命令类型 — parser 输出 + executor switch 必须穷尽此联合 */
export type DslCommandType =
  | 'probe' | 'detail' | 'schema'  // deprecated — removed from parser, use retrieve instead
  | 'retrieve'
  | 'open'
  | 'compile' | 'write' | 'save' | 'undo'
  | 'add-node' | 'add-comp'
  | 'set-prop' | 'set-props' | 'delete-node' | 'reparent' | 'duplicate' | 'set-active'
  | 'note' | 'ask' | 'done' | 'help';

/** @deprecated 使用 DslCommandType */
export type DslCommandKind = DslCommandType;

/** 编辑子命令类型 */
export type EditKind =
  | 'set-prop' | 'set-props'
  | 'delete-node' | 'reparent' | 'duplicate' | 'set-active'
  | 'add-component' | 'add-node-tree';

export interface DslCommand {
  type: DslCommandType;
  notes?: NoteEntry[];

  // retrieve
  probeType?: string;
  schemas?: string[];
  probes?: Array<Record<string, unknown>>;
  hints?: string;
  /** 场景树展开深度: number | "all" (默认 3) */
  depth?: number | 'all';
  /** 详情级别: "structure" (仅组件类型) | "full" (含当前属性值, 默认 structure) */
  detail?: 'structure' | 'full';
  /** 聚焦节点 fileId */
  focus?: string;
  // probe (deprecated, use retrieve)
  path?: string;
  paths?: string[];
  nodeUuid?: string;
  component?: string;
  property?: string;
  pattern?: string;
  query?: string;

  // schema (deprecated, use retrieve)
  // open
  assetPath?: string;

  // compile / node / comp
  spec?: CompileSpec;
  tempId?: string;
  parent?: string;
  name?: string;
  compType?: string;
  props?: Record<string, unknown>;
  contentSize?: { width: number; height: number };
  anchorPoint?: { x: number; y: number };
  position?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  active?: boolean;

  // write
  assetType?: string;
  json?: unknown;
  dbUrl?: string;
  saveMode?: string;

  // ask
  question?: string;

  // edit
  editType?: EditKind;
  value?: unknown;
  values?: Record<string, unknown>;

  // undo

  // 自由扩展
  [key: string]: unknown;
}

export interface ParsedDslOutput {
  commands: DslCommand[];
  done: boolean;
  rawNotes?: NoteEntry[];
  /** done() 携带的汇报数据，Commander 用 key=value 总结本轮做了什么 */
  doneReport?: Record<string, unknown>;
  /** 被忽略的未知命令名列表，供 Gateway 反馈给 Commander */
  warnings?: string[];
}

// ============================================================
// 编排类型
// ============================================================

export interface AssemblyOptions {
  request: string;
  projectPath: string;
  sessionMemory: import('./memory/session-memory.js').CommanderState;
  assetCache: import('./memory/asset-cache.js').AssetCache;
  documentState: import('./memory/document-state.js').DocumentState;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  signal?: AbortSignal;
  onFeedback?: (text: string) => void;
  onExecutionEvent?: (event: ExecutionEvent) => void;
  /** 从上一轮 ask 恢复的对话状态，Gateway 自动恢复 messages + tempIds + 已知节点 */
  commanderSnapshot?: import('./memory/session-store.js').CommanderSnapshot;
}

export interface AssemblyResult {
  ok: boolean;
  status?: 'completed' | 'cancelled' | 'error' | 'ask';
  error?: string;
  round: number;
  results?: ExecutedCommand[];
  notes?: NoteEntry[];
  cancelled?: boolean;
  /** done() 携带的汇报数据，Commander 总结本轮做了什么 */
  doneReport?: Record<string, unknown>;
  /** Commander 发出 >ask() 时的问题数据 — 直接返回给外部 LLM */
  ask?: Record<string, unknown>;
  /** done() 成功时的结构化差异报告 */
  diffs?: PrefabDiffResult[];
  /** 回滚记录 */
  rollbacks?: RollbackResult[];
  /** Commander ask 时的完整对话快照 — 调用方保存到 session，下次恢复 */
  commanderSnapshot?: import('./memory/session-store.js').CommanderSnapshot;
}

export interface RollbackResult {
  path: string;
  success: boolean;
  error?: string;
  /** 回滚时的 console 错误/警告日志（操作时间窗口内） */
  consoleLogs?: ConsoleLogEntry[];
}

export interface ConsoleLogEntry {
  level: string;
  message: string;
  timestamp: number;
}

export interface ExecutedCommand {
  command: DslCommand;
  result: CmdResult;
}

// ============================================================
// 执行事件 — Gateway → Overlay 实时数据流
// ============================================================

export type ExecutionEventKind =
  | 'session-start'
  | 'session-done'
  | 'session-error'
  | 'round-start'
  | 'command-executed';

export interface ExecutionEvent {
  schema: 'Comdr.execution-event.v1';
  seq: number;
  kind: ExecutionEventKind;
  round: number;
  index?: number;
  command?: { type: string; [key: string]: unknown };
  result?: { ok: boolean; type?: string; error?: string; errorCode?: string; data?: unknown };
  elapsedMs?: number;
  totalRounds?: number;
  status?: 'completed' | 'max_rounds' | 'cancelled' | 'error' | 'ask';
  ask?: string;
  error?: string;
  message?: string;
  /** done() 携带的汇报数据，Overlay 展示用 */
  doneReport?: Record<string, unknown>;
  timestamp: string;
}

// ============================================================
// 资产路径引用
// ============================================================

export interface AssetPathRef {
  path: string;
  parent: Record<string, unknown>;
  key: string;
  resolved?: string;
}
