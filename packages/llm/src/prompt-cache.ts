/**
 * prompt-cache.ts — 前缀保持策略（DeepSeek 全自动前缀缓存）
 *
 * DeepSeek 使用全自动前缀匹配缓存，无需手动 cache_control 标记。
 * 此模块保证:
 *   1. system prompt 不含时间戳/动态ID — 保证前缀固定
 *   2. tool definitions 每次序列化顺序一致 — sort_keys
 *   3. 历史消息只追加不修改 — 不插入/修改/删除中间的消息
 *
 * 这三条保证 DeepSeek 自动前缀缓存最大命中。
 *
 * @agent Agent 2 — 此文件由 Agent 2 维护
 */

import type { ToolDefinition, Message } from '@comdr/core/types';
import type { ToolBlueprint } from '@comdr/core';

// ============================================================================
// §1 工具定义序列化（sort_keys 保证一致性）
// ============================================================================

/**
 * 将 ToolDefinition[] 序列化为稳定的 JSON 字符串（OpenAI/DeepSeek 格式）
 *
 * 每次调用返回完全相同的字符串（当输入相同时）。
 * sort_keys 保证 DeepSeek 前缀缓存命中。
 *
 * DeepSeek 期望的格式:
 *   [{ "type": "function", "function": { "name": "...", "description": "...", "parameters": {...} } }]
 *
 * @param tools 工具定义数组
 * @returns 稳定排序的 JSON 字符串
 */
export function serializeTools(tools: ToolDefinition[]): string {
  // 转换为 OpenAI tool 格式
  const formatted = tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  // 按 function.name 排序
  const sorted = [...formatted].sort((a, b) =>
    a.function.name.localeCompare(b.function.name),
  );

  // JSON.stringify 带 sortedKeys — 保证嵌套对象的 key 顺序一致
  return JSON.stringify(sorted, sortedKeys, 2);
}

/**
 * JSON.stringify replacer: 按 key 排序
 */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * ★ 将 ToolBlueprint 序列化为稳定 JSON——用于 fingerprint 计算。
 *
 * schema version + nodes/edges sorted by name 保证同输入同输出。
 * 与 serializeTools 的不变式保证一致——每次调用返回完全相同的字符串。
 *
 * @param bp 编译后的蓝图
 * @returns 稳定排序的 JSON 字符串
 */
export function serializeBlueprint(bp: ToolBlueprint): string {
  // 节点按 name 排序
  const sortedNodes = [...bp.nodes].sort((a, b) => a.name.localeCompare(b.name));
  // 边按 from→to→type 排序
  const sortedEdges = [...bp.edges].sort((a, b) => {
    const fa = `${a.from}→${a.to}:${a.type}`;
    const fb = `${b.from}→${b.to}:${b.type}`;
    return fa.localeCompare(fb);
  });

  const stable: ToolBlueprint = {
    ...bp,
    nodes: sortedNodes,
    edges: sortedEdges,
  };

  return JSON.stringify(stable, sortedKeys, 2);
}

// ============================================================================
// §2 System Prompt 稳定性检查
// ============================================================================

/**
 * 构建固定的 system prompt 前缀
 *
 * 规则:
 *   - 不含时间戳
 *   - 不含动态 session ID
 *   - 不含随机值
 *   - 每次调用返回完全相同的字符串
 *
 * @returns 固定 system prompt
 */
export function buildSystemPromptPrefix(): string {
  return `You are Comdr, a coding agent that orchestrates tool execution with a TypeScript orchestration layer and a Rust execution layer.

## Core Principles
1. Read before you write — never edit a file you have not read
2. Verify after you edit — check that the actual diff matches the intent
3. Report honestly — if a test fails or a tool errors, state it plainly; never claim success when something went wrong
4. One change at a time — prefer minimal, targeted edits over bulk rewrites; small steps are easier to verify and roll back
5. Match the surrounding code — follow existing naming, structure, comment density, and coding style
6. Use constants over magic strings — Comdr provides AGENT_EVENT, TOOL_PERMISSION, ERROR_CATEGORY, and other const objects; never hardcode string literals that have a defined constant

## Tool Selection
Prefer dedicated tools over raw shell commands. They are faster, safer, and produce structured results.
Check tool descriptions for parameters and usage details.

### MCP tools — external agents (first-class, essential)
Comdr connects to specialized agent processes through MCP (Model Context Protocol). These are NOT fallbacks or optional utilities — they are the primary way to accomplish tasks in their respective domains.

**comdr-art** — the AI art pipeline agent. Use this for ANY game asset task: UI backgrounds, logos, icons, character sprites, style-specific imagery. It handles the full pipeline from requirements → generation → review → asset registration. Expect 30-120 seconds per call. Requires a running ComfyUI instance. There is no other way to generate game assets — do not try to create images via shell commands or file operations.

**comdr-engine** — the Cocos Creator editor agent. Use this for ANY editor operation: creating scenes, editing prefabs, adding components, setting properties, attaching scripts to nodes, querying the asset database. Requires Cocos Creator with the comdr-cocos-bridge extension enabled. There is no other way to operate the Cocos editor — do not try to edit .scene or .prefab JSON directly with file tools.

Tool names follow the pattern \`mcp__<server>__<tool>\`. Both agents are configured via \`.comdr.toml\` and their availability is shown in the MCP status panel.

## Edit Workflow
1. Read the target file first
2. Plan the exact old_string → new_string replacement
3. Execute file_edit (or file_write for new files)
4. Verify with file_read or shell_bash (run tests, check build)
5. If the edit fails or the diff is wrong, report the failure — do not silently move on

## Parallel Execution
When you need to make multiple independent calls, invoke them together in a single turn:
- Reading several files at once — parallel
- glob + grep to locate code — parallel
- Git status + git diff — parallel
- Dependent operations MUST be sequential — do not edit a file before reading it, do not call a tool that depends on a previous result
- Limit parallel calls to 5 at a time to keep latency manageable

## Safety Rules
- Never guess file paths — use file_glob or file_grep to discover them
- Never push to git or change remote config unless explicitly asked
- Destructive operations (delete, force push, rm -rf) require user confirmation
- Do not invent error codes or event types — use the constants from @comdr/core

## Project Conventions
- File names: kebab-case (e.g., prompt-cache.ts)
- Types/interfaces: PascalCase
- Functions/variables: camelCase
- Enum values: UPPER_SNAKE_CASE strings
- Discriminated unions: always use a \`type\` field
- Shared types belong in @comdr/core only — do not redefine them in other packages`;
}

// ============================================================================
// §3 Messages 历史完整性检查
// ============================================================================

/**
 * 验证 messages 数组的历史完整性
 *
 * 历史消息规则: 只追加，不插入/修改/删除中间的消息。
 * 此函数用于调试——生产代码中由 Engine 保证。
 *
 * @param previous 上一轮的 messages
 * @param current 本轮的 messages
 * @returns true = 历史未被篡改
 */
export function validateMessageHistoryIntegrity(
  previous: Message[],
  current: Message[],
): boolean {
  if (current.length < previous.length) {
    // 消息数减少了——历史被删除
    return false;
  }

  for (let i = 0; i < previous.length; i++) {
    const prev = previous[i]!;
    const curr = current[i]!;

    if (prev.role !== curr.role) return false;
    if (prev.content !== curr.content) return false;
    if (prev.tool_call_id !== curr.tool_call_id) return false;

    // reasoning_content 必须保留
    if (prev.reasoning_content !== curr.reasoning_content) return false;
  }

  return true;
}

// ============================================================================
// §4 前缀缓存命中策略
// ============================================================================

/**
 * 缓存前缀层级说明:
 *
 * Layer 1: System Prompt       — 固定（buildSystemPromptPrefix 保证）
 * Layer 2: Tool Definitions     — 固定（serializeTools 保证 sort_keys）
 * Layer 3: Session Anchor       — 固定（同一次会话不变）
 *
 * 前三层不变 → DeepSeek 自动前缀缓存命中
 *
 * Layer 4: State + Intent Window — 变化（但很小）
 * Layer 5: Recent History        — 变化（只追加）
 * Layer 6: User Input            — 变化（每轮不同）
 *
 * 缓存边界: Layer 1-3 不匹配时缓存失效（新会话/改 system prompt）
 */

/**
 * 计算缓存命中率（从 token 统计中提取）
 */
export function computeCacheHitRate(
  cacheHitTokens: number,
  cacheMissTokens: number,
): number {
  const total = cacheHitTokens + cacheMissTokens;
  if (total === 0) return 0;
  return cacheHitTokens / total;
}

/**
 * 预估前缀缓存命中的 token 数
 *
 * system prompt + tool definitions 的 token 数约:
 *   system: ~200 tokens
 *   tools:  ~50-200 tokens per tool
 */
// ★ 当前未被调用——保留作为前缀缓存容量规划的参考文档
function _estimateCacheableTokens(toolCount: number): number {
  const systemTokens = 200;
  const avgTokensPerTool = 100;
  return systemTokens + toolCount * avgTokensPerTool;
}
