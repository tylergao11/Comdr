/**
 * @comdr/engine — Agent 4
 *
 * 编排核心——实现 IEngine 契约，将 LLM + Tools + Memory + Skills
 * 编织成完整的 Agent 主循环。
 *
 * 导出的层次:
 *   ./loop         → Engine 类（主入口）
 *   ./prompt       → PromptConstructor（7 层 prompt 构造）
 *   ./reasoning    → ReasoningManager（DeepSeek reasoning_content 管理）
 *   ./context      → ContextManager（结构化锚定迭代摘要）
 *   ./planner      → TaskPlanner（层级任务路由）
 *   ./reflection   → ReflectionEngine（MIRROR 双重反思）
 *   ./progress     → ProgressMeter（多维进度检测）
 *   ./skills       → SkillsLoader（渐进式 Skills 加载）
 *   ./memory/working  → WorkingMemory（双窗口工作记忆）
 *   ./memory/episodic → EpisodicMemory（情景记忆 + embedding）
 *   ./memory/semantic → SemanticMemory（代码索引四张图）
 *
 * 使用方式:
 *   import { createEngine } from '@comdr/engine';
 *   import { DeepSeekClient } from '@comdr/llm';
 *   import { loadConfig } from '@comdr/core';
 *
 *   const config = loadConfig(process.cwd());
 *   const llm = new DeepSeekClient(config.llm);
 *   const engine = createEngine(llm, config);
 *
 *   for await (const event of engine.run("创建 hello.ts", "agent")) {
 *     console.log(event);
 *   }
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

// ============================================================================
// §1 Public API — 外部包（ui、vscode）唯一导入
// ============================================================================
export { Engine, createEngine } from './loop.js';

// ============================================================================
// §2 Internal — 测试和高级组合使用
// ============================================================================
export { ReasoningManager } from './reasoning.js';
export { PromptConstructor, emptyAnchor, anchorFromWindows } from './prompt.js';
export { ContextManager } from './context.js';
export { TaskPlanner } from './planner.js';
export { ReflectionEngine } from './reflection.js';
export type { LSPCorrectionDecision } from './reflection.js';
export { ProgressMeter } from './progress.js';
export { SkillsLoader } from './skills.js';

// ===== 智能截断/压缩工具（供其他 Agent 使用） =====
export {
  summarizeToolOutput,
  summarizeSegmentText,
  summarizeDiff,
  deriveStableKey,
  smartDisplayTruncate,
} from './smart-truncate.js';

// ===== 记忆系统 =====
export { WorkingMemory } from './memory/working.js';
export { EpisodicMemory, createEpisodicMemory } from './memory/episodic.js';
export { SemanticMemory, createSemanticMemory } from './memory/semantic.js';
// ProceduralMemory 已删除——跨项目模式提取属于猜 LLM 行为。

// ===== 自检管线 =====
export { builtinRules, siblingConsistencyRule, fileSizeGuardRule } from './self-check.js';
export type { CheckRule, CheckIssue, CheckContext } from './self-check.js';

// ===== 持久化 =====
export { SessionStore, createSessionStore } from './persistence.js';

// ===== MCP 集成 =====
export { MCPClient, createMCPClient } from './mcp-client.js';
export type { MCPServerStatus } from '@comdr/core/types';
export type { MCPToolResult } from './mcp-client.js';

// ===== World Model（COMDR.md 多源自动发现） =====
export { discoverComdrMd, discoverAndRetrieve, buildLSPWorldChunks, extractKeyFiles } from './world-model.js';
export type { WorldModelChunk, WorldModelResult } from './world-model.js';

// ===== Trigram 检索（当前主力——零模型、零正则） =====
// ★ 迁入 @comdr/core 后以此处为统一出口
export {
  textToVector,
  textsToVectors,
  cosineSimilarity,
  TrigramIndex,
} from '@comdr/core';
export type { IndexedDoc } from '@comdr/core';

// ===== 旧 BM25 模块（@deprecated——仅 file_search 使用） =====
export {
  tokenize,
  BM25Scorer,
  contextualPrefix,
  l2Normalize,
} from './retrieval.js';

export { generateRepoMap } from './repo-map.js';
export { runSubAgent, fanOut, pipeline } from './subagent.js';
export type { SubAgentOpts, SubAgentResult } from './subagent.js';
export { SubAgentRegistry } from './subagent-registry.js';
