/**
 * @comdr/llm — Agent 2
 *
 * DeepSeek API 客户端——提供 chat() 和 chatStream() 调用
 *
 * 实现 Contract A: IDeepSeekClient
 *
 * 导出的层次:
 *   ./client        → DeepSeekClient 类（核心 API）
 *   ./prompt-cache   → 前缀保持工具（Agent 4 使用）
 *
 * 其他 Agent 的使用方式:
 *   import { DeepSeekClient } from '@comdr/llm';
 *   import type { IDeepSeekClient } from '@comdr/core/contracts';
 */

// ===== 核心客户端 =====
export { DeepSeekClient } from './client.js';

// ===== 工具函数 =====
export { isReasonerModel } from './client.js';

// ===== 前缀缓存工具 =====
export {
  serializeTools,
  serializeBlueprint,
  buildSystemPromptPrefix,
  validateMessageHistoryIntegrity,
  computeCacheHitRate,
} from './prompt-cache.js';
