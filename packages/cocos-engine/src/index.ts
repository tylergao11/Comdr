// ============================================================
// @comdr/core — 公开 API
// ============================================================

// 类型
export * from './types.js';

// 基础
export { VERSION } from './foundation/constants.js';
export * as valueKit from './foundation/value-kit.js';
export * as errorCodes from './errors/error-codes.js';

// 统一模型（全系统唯一真相源）
// CompileSpec/NodeSpec/ComponentSpec/AssemblyStats 由 types.ts 重新导出，避免重复
export {
  CocosVec2, CocosVec3, CocosVec4, CocosSize, CocosColor, CocosQuat, CocosRect,
  CocosMathType, CocosReference, CocosValue,
  ComponentIdentity, PropertySchema,
  CocosComponent, CocosNode, CocosAsset,
  SerializedComponent, SerializedNode, SerializedPrefab, SerializedPrefabInfo,
  SerializedCompPrefabInfo, SerializedObject, PrefabJson,
  BuiltNode, BuiltPrefab,
  VALUE_TYPE_TEMPLATES, VALUE_TYPE_NAMES, NODE_TEMPLATE,
  PREFAB_WRAPPER_TEMPLATE, PREFAB_INFO_TEMPLATE, COMP_PREFAB_INFO_TEMPLATE,
  PREFAB_INSTANCE_TEMPLATE, TARGET_INFO_TEMPLATE, PROPERTY_OVERRIDE_INFO_TEMPLATE,
  generateComponentTemplate, minimalComponentTemplate,
  isCompressedUuidType, isValueType, isInfraType, isEngineComponentType,
  parseComponentIdentity,
  AssemblerResult,
  RefResolver, NOOP_RESOLVER,
} from './model/cocos-world.js';
export { ComponentCatalog, createRefResolver } from './model/component-catalog.js';
export type { ComponentEntry, ComponentKnowledge, KnowledgeChildNode } from './model/component-catalog.js';
export type { ProbeRequest, ProbeResponse, ProbeKind } from './model/probe-protocol.js';

// 记忆层
export { CommanderState, SessionMemory } from './memory/session-memory.js';
export { AssetCache } from './memory/asset-cache.js';
export { DocumentState } from './memory/document-state.js';
export { SnapshotManager, UndoManager } from './memory/undo-manager.js';
export type { BackupData, BackupInfo, SnapshotEntry } from './memory/undo-manager.js';
export { loadSession, saveSession, recordCreated, recordModified, recordOpenDocument, buildSummary, type CommanderSnapshot, type Session } from './memory/session-store.js';

// 翻译层
export { assemble, assembleSubtree, generateFileId } from './translation/assembler/index.js';
export { validate } from './translation/assembler/validate.js';
export { enrich } from './translation/assembler/enrich.js';
export { clean, computeStats } from './translation/assembler/clean.js';

// 上下文层
export { resolveProjectContext, discoverCandidates, scoreCocosProjectPath, isSpecializedProjectContext } from './context/project-context.js';

// 项目感知
export { ProjectSnapshot, NodeEntry, PrefabEntry, SceneEntry, ScriptEntry, ResourceEntry, EMPTY_SNAPSHOT, buildFromAssetsProbe, buildFromScriptsProbe, buildNodeEntriesFromCtx, findNodeByName, collectNodeNames } from './perception/project-snapshot.js';

export { diffPrefab, diffAllSnapshots, formatDiffResults } from './perception/prefab-diff.js';
export type { DiffEntry, PrefabDiffResult } from './perception/prefab-diff.js';

// 配置层
export { loadGatewayConfig, getActiveProvider, resolveCommanderModel, MODEL_TIERS } from './config/config-store.js';

// DSL
export { parseDslOutput } from './dsl/parser.js';
export { formatCommandResults } from './dsl/formatter.js';

// Gateway
export { AssemblyGateway, runAssemblyProcess } from './gateway/assembly-gateway.js';

// Overlay
export { ensureOverlayRunning } from './overlay/overlay-launcher.js';
export { callCommander } from './gateway/commander.js';
export { generateSystemPrompt } from './gateway/prompt.js';
export { ExecutionLogger } from './gateway/execution-logger.js';

// ToolCenter
export { ToolCenter } from './tool-center/tool-center.js';

// SubAgent Adapter
export { CocosSubAgent, createSubAgent } from './subagent-adapter.js';
