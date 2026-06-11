/**
 * @comdr/core — Agent 1
 *
 * 全系统共享类型 + 配置 + 日志 + 契约定义
 *
 * 导出的层次:
 *   ./types      → 纯类型（import type），zero runtime cost
 *   ./contracts  → 接口契约 + 错误类（有 runtime）
 *   ./config     → 配置加载（Agent 1 实现）
 *   ./logging    → 事件日志（Agent 1 实现）
 *
 * 其他 Agent 的使用方式:
 *   import type { Message, AgentEvent } from '@comdr/core/types';
 *   import { IDeepSeekClient, INativeTools } from '@comdr/core/contracts';
 */

// ===== 类型（type-only exports） =====
// ★ @comdr/core 是类型的唯一真理源。types.ts 中所有类型均对外公开。
//   废弃类型（如 ToolExecuteResult）应直接从 types.ts 中删除，而非在导出层隐藏。
export type * from './types.js';

// ===== 常量（runtime value exports） =====
export {
  AGENT_EVENT,
  TOOL_PERMISSION,
  PERMISSION_MODE,
  RUN_MODE,
  TASK_TYPE,
  THINKING_EFFORT,
  THINKING_TYPE,
  MESSAGE_ROLE,
  SERVER_STATUS,
  ERROR_CATEGORY,
  TERMINATION_REASON,
  SYSTEM,
  MODEL_ROLE,
  ALL_TOOLS_SENTINEL,
  MASKED_PREFIX,
  VALID_SCHEMA_TYPES,
  validateJSONSchemaProperty,
  LSP_SEVERITY,
} from './types.js';

// ===== 契约接口 =====
export type {
  IDeepSeekClient,
  INativeTools,
  IEngine,
  IConfigLoader,
  IEventLogger,
  IShadowWorkspace,
  ILSPBridge,
  ContractVerification,
  ContractVerifier,
  ISubAgent,
  SubAgentManifest,
  SubAgentFactory,
  SubAgentToolResult,
} from './contracts.js';

// ===== 契约错误类（runtime） =====
export {
  DeepSeekAuthError,
  DeepSeekRetryError,
  ConfigValidationError,
  LSPConnectionError,
} from './contracts.js';

// ===== 配置加载（Agent 1 实现 Contract D） =====
export {
  loadConfig,
  reloadConfig,
  createConfigLoader,
} from './config.js';

// ===== 日志系统（Agent 1 实现 Contract E） =====
export {
  EventLogger,
  createEventLogger,
} from './logging.js';

// ===== Trigram 向量检索（零依赖纯函数——engine + audit 共用） =====
export {
  textToVector,
  textsToVectors,
  cosineSimilarity,
  TrigramIndex,
  TRIGRAM_DEFAULT_DIMS,
} from './trigram.js';
export type { IndexedDoc } from './trigram.js';

// ===== 反馈机制 =====
export { computeCredit } from './types.js';

// ===== 通用工具函数 =====

/**
 * Promise-based sleep
 * @param ms 毫秒（clamp 到 [0, 60_000]，防止 Infinity/NaN/负数）
 */
export function sleep(ms: number): Promise<void> {
  const clamped = Math.max(0, Math.min(ms, 60_000));
  if (!isFinite(clamped)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, clamped));
}
