/**
 * types.ts — 全系统共享类型
 *
 * ## 命名规则（所有 Agent 必须遵守）
 *
 * - 类型/接口（type / interface）    → PascalCase  例: `Message`, `AgentEvent`
 * - 函数/变量（function / variable） → camelCase   例: `loadConfig`, `tokensUsed`
 * - 常量/枚举值（const / enum member）→ UPPER_SNAKE_CASE 字符串  例: `'READ_ONLY'`
 * - 文件命名                          → kebab-case  例: `prompt-cache.ts`, `mcp-server.ts`
 * - 包名                              → @comdr/xxx  例: `@comdr/core`, `@comdr/llm`
 * - 可辨识联合的判别字段               → 一律用 `type`
 * - 错误码                            → UPPER_SNAKE_CASE 字符串
 * - 异步函数返回                      → 一律 `Promise<T>`，不裸奔
 *
 * ## 契约标记
 *
 * `@contract` JSDoc 标记表示该类型是跨 Agent 边界的契约。
 * 修改这些类型 = 破坏性变更，必须同步更新所有消费者。
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护，是类型的唯一真理源
 */

// ============================================================================
// §1 基础/工具类型
// ============================================================================

/**
 * JSON Schema 对象（简化版，用于 tool parameters 定义）
 * @contract Agent 2,3,4 都依赖此类型
 */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  default?: unknown;
}

/**
 * 有效的 JSON Schema property type 值。
 * 作为唯一真理源——所有 schema 解析代码引用此集合。
 */
export const VALID_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'array',
  'object',
] as const);

/** JSON Schema type 值 */
export type SchemaType = JSONSchemaProperty['type'];

/**
 * ★ 类型安全的 JSONSchemaProperty 验证器。
 *
 * 替换所有 `value as JSONSchemaProperty` 的不安全转换。
 * 返回值保证符合 JSONSchemaProperty 契约，否则返回 null。
 *
 * @contract 所有 Agent 使用此函数替代 as 转换
 */
export function validateJSONSchemaProperty(
  raw: unknown,
): JSONSchemaProperty | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const prop = raw as Record<string, unknown>;
  const type = prop.type;
  if (typeof type !== 'string' || !VALID_SCHEMA_TYPES.has(type as SchemaType)) return null;

  const result: JSONSchemaProperty = {
    type: type as JSONSchemaProperty['type'],
  };

  if (typeof prop.description === 'string') {
    result.description = prop.description;
  }

  if (Array.isArray(prop.enum)) {
    result.enum = prop.enum.filter(
      (v): v is string => typeof v === 'string',
    );
  }

  if (prop.items !== undefined) {
    const items = validateJSONSchemaProperty(prop.items);
    if (items) result.items = items;
  }

  if (prop.properties !== undefined && typeof prop.properties === 'object' && !Array.isArray(prop.properties)) {
    const nestedProps: Record<string, JSONSchemaProperty> = {};
    for (const [key, val] of Object.entries(
      prop.properties as Record<string, unknown>,
    )) {
      const validated = validateJSONSchemaProperty(val);
      if (validated) nestedProps[key] = validated;
    }
    if (Object.keys(nestedProps).length > 0) {
      result.properties = nestedProps;
    }
  }

  return result;
}

// ============================================================================
// §2 消息系统
// ============================================================================

/**
 * 消息角色
 * @contract Agent 2,3,4 都使用
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 单条消息
 *
 * ★ DeepSeek 关键规则: reasoning_content 必须保留并回传。
 * 丢 = 下一轮 400 错误。Agent 2 必须保证 message 对象的完整性。
 *
 * @contract Agent 2 → Agent 4，Agent 4 内部传递
 */
export interface Message {
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * ★ DeepSeek 特有。即使是空字符串也必须保留并回传，丢失 = 400 错误。
   * 生命周期管理由 Agent 4 reasoning.ts 负责，Agent 2 负责原样传递。
   */
  reasoning_content?: string;
  /** Chat Prefix Completion 标记（beta endpoint） */
  prefix?: boolean;
}

/**
 * LLM 返回的工具调用
 * @contract Agent 2 → Agent 4
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON 字符串，由调用方 parse */
    arguments: string;
  };
}

/**
 * ★ 结构化错误分类（Agent 3 SDB 返回，Agent 4 reflection.inter() 消费）
 *
 * 这是工具错误的唯一分类维度——不再有冗余的 errorCode 字符串。
 *
 * SDB Step 映射:
 *   Step1→schema_invalid, Step2→permission_denied,
 *   Step4→timeout, Step5→diff_mismatch, Step6→test_failed,
 *   快照失败→snapshot_failed, 回滚失败→rollback_failed,
 *   其他→execution_error
 *
 * @contract Agent 3,4 对齐 — ToolResult 和 ToolExecuteResult 共享此类型
 */
export type ErrorCategory =
  | 'schema_invalid'
  | 'permission_denied'
  | 'timeout'
  | 'file_not_found'
  | 'test_failed'
  | 'diff_mismatch'
  | 'snapshot_failed'
  | 'rollback_failed'
  | 'execution_error';

/**
 * 工具执行结果
 * @contract Agent 3 → Agent 4，Agent 4 → Agent 5
 */
export interface ToolResult {
  callId: string;
  /** 工具名——避免消费者跨索引查找。对应 ToolCall.function.name。 */
  toolName: string;
  ok: boolean;
  content: string | null;
  /** SDB Step 5 Diff Validate 输出 */
  diffSummary?: string;
  /** SDB Step 3 快照 ID，回滚用 */
  snapshotId?: string;
  /** 结构化错误分类——工具错误的唯一分类维度 */
  errorCategory?: ErrorCategory;
  /** 墙钟执行耗时（毫秒），由 SDB Gate 测量 */
  durationMs?: number;
  /** SDB Step 6 Test Feedback 结果 */
  testFeedback?: TestFeedback;
}

/** SDB Step 6: 自动测试反馈 */
export interface TestFeedback {
  /** 通过的测试数 */
  passed: number;
  /** 失败的测试数 */
  failed: number;
  /** 测试输出（前 2000 字符，用于诊断） */
  output?: string;
  /** 执行的测试文件路径 */
  testFile?: string;
}

// ============================================================================
// §3 工具系统
// ============================================================================

/**
 * 工具权限级别
 * @contract Agent 3,4,5 对齐
 */
export type ToolPermission =
  | 'read_only'
  | 'destructive'
  | 'requires_approval';

/**
 * 工具定义（注册时使用）
 * @contract Agent 3 → Agent 4
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  permission: ToolPermission;
  /** 毫秒，0 = 无限制 */
  timeoutMs: number;
}

/**
 * Agent 4 调用 Agent 3 的入参
 * @contract Agent 4 → Agent 3
 */
export interface ToolExecuteOptions {
  /** 工具名，对应 ToolDefinition.name */
  name: string;
  /** LLM tool call ID — Agent 3 原样回传，Agent 4 用于关联结果与调用 */
  callId: string;
  /** 参数对象（已由 SDB Step 1 校验） */
  arguments: Record<string, unknown>;
  /** 项目根目录（绝对路径，用于相对路径解析） */
  projectPath?: string;
  /** 超时毫秒，覆盖 ToolDefinition.timeoutMs */
  timeoutMs: number;
}

/**
 * Agent 3 返回的执行结果（原生层 → 已合并进 ToolResult）
 *
 * @deprecated 使用 ToolResult 代替。INativeTools.execute() 现在直接返回 ToolResult。
 *   保留此类型仅用于向后兼容的文档引用。
 * @contract Agent 3 → Agent 4
 */
export interface ToolExecuteResult {
  ok: boolean;
  content: string | null;
  diffSummary?: string;
  snapshotId?: string;
  /** 结构化错误分类——工具错误的唯一分类维度 */
  errorCategory?: ErrorCategory;
}

// ============================================================================
// §4 MCP Server 状态（共享 UI 类型）
// ============================================================================

/**
 * MCP Server 连接状态——供 AgentEventMCPStatus 和 Agent 5 面板渲染使用
 * @contract Agent 4 → Agent 5
 */
export interface MCPServerStatus {
  name: string;
  status: 'connected' | 'connecting' | 'offline' | 'error';
  transport: 'stdio' | 'tcp';
  uptime?: number;
  pid?: number;
  error?: string;
  /** 该 server 提供的工具名列表 */
  tools: string[];
}

// ============================================================================
// §5 Agent 事件（流式传输协议）
// ============================================================================

/**
 * Agent 事件——Agent 4 通过此协议向 Agent 5 推送实时状态
 *
 * 流式语义:
 *   text_delta       → 逐 token 推送，Agent 5 实时渲染
 *   thinking_delta   → 推理过程流式片段，可折叠显示
 *   tool_call        → LLM 请求工具，Agent 5 显示 ⏳ 状态
 *   tool_result      → 工具执行完成，Agent 5 显示 ✓/✗
 *   progress_warning → 停滞告警，Agent 5 闪烁提示
 *   session_started  → 会话已初始化（含 sessionId + mode）
 *   turn_begin       → 新一轮开始（含 turn + 累计 tokens）
 *   token_usage      → LLM 响应后的实际 token 用量
 *   mcp_status       → MCP Server 连接状态变化
 *   done             → 执行完成，携带完整 RunResult
 *   error            → 不可恢复错误，终端显示
 *
 * @contract Agent 4 → Agent 5
 */
export type AgentEvent =
  | AgentEventTextDelta
  | AgentEventThinkingDelta
  | AgentEventToolCall
  | AgentEventToolResult
  | AgentEventProgressWarning
  | AgentEventSessionStarted
  | AgentEventTurnBegin
  | AgentEventTokenUsage
  | AgentEventMCPStatus
  | AgentEventDone
  | AgentEventError;

// ---- 实时增量事件 ----

export interface AgentEventTextDelta {
  type: 'text_delta';
  content: string;
}

export interface AgentEventThinkingDelta {
  type: 'thinking_delta';
  content: string;
}

// ---- 工具事件 ----

export interface AgentEventToolCall {
  type: 'tool_call';
  call: ToolCall;
}

export interface AgentEventToolResult {
  type: 'tool_result';
  result: ToolResult;
}

// ---- 进度事件 ----

export interface AgentEventProgressWarning {
  type: 'progress_warning';
  message: string;
  /** 连续停滞轮数 */
  stalledTurns: number;
}

// ---- 会话生命周期事件（NEW） ----

export interface AgentEventSessionStarted {
  type: 'session_started';
  sessionId: string;
  mode: RunMode;
}

export interface AgentEventTurnBegin {
  type: 'turn_begin';
  turn: number;
  tokensUsed: number;
}

export interface AgentEventTokenUsage {
  type: 'token_usage';
  /** LLM 调用后的实际 token 统计 */
  usage: TokenUsage;
}

export interface AgentEventMCPStatus {
  type: 'mcp_status';
  servers: MCPServerStatus[];
}

// ---- 终止事件 ----

export interface AgentEventDone {
  type: 'done';
  /** ★ 完整 RunResult——避免与 AgentEventDone 字段重复 */
  result: RunResult;
}

export interface AgentEventError {
  type: 'error';
  code: string;
  message: string;
  /** 是否可恢复（恢复 = 注入纠正反馈继续，不可恢复 = 终止） */
  recoverable: boolean;
}

// ============================================================================
// §6 上下文系统
// ============================================================================

/**
 * State Window 条目——记录 WHAT changed
 * key 稳定（如 file:src/foo.ts），同 key 覆盖
 * @contract Agent 4 内部使用
 */
export interface StateEntry {
  /** 稳定 key，同 key 覆盖（如 "file:src/foo.ts"） */
  key: string;
  /** 一行紧凑描述 */
  text: string;
  /** 创建轮次 */
  turn: number;
}

/**
 * Intent Window 条目——记录 WHY changed
 * 每条关联一个 StateEntry.key
 * @contract Agent 4 内部使用
 */
export interface IntentEntry {
  /** 关联的 StateEntry.key */
  key: string;
  /** 一句人类可读的意图描述 */
  why: string;
  /** 创建轮次 */
  turn: number;
}

// ============================================================================
// §7 配置系统
// ============================================================================

/**
 * 根配置
 * @contract 所有 Agent 使用
 */
export interface AgentConfig {
  llm: LLMConfig;
  project: ProjectConfig;
  agent: AgentBehaviorConfig;
}

/**
 * LLM 配置（DeepSeek 专用）
 * @contract Agent 2 消费
 */
export interface LLMConfig {
  apiKey: string;
  /** https://api.deepseek.com 或 beta endpoint */
  baseUrl: string;
  model: string;
  maxTokens: number;
  thinking: ThinkingConfig;
}

/**
 * thinking 配置
 * DeepSeek 要求: thinking 是顶层字段，不是 extra_body
 * @contract Agent 2 消费
 */
export type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'enabled'; effort: 'high' | 'max' };

/**
 * 项目配置
 * @contract Agent 1（加载）、Agent 4（使用 MCP servers）
 */
export interface ProjectConfig {
  projectPath: string;
  skillsDir: string;
  mcpServers: MCPServerConfig[];
  /**
   * 项目专属指令文件（类似 Claude Code 的 CLAUDE.md）。
   * 相对于 projectPath 的路径，默认 `comdr.md`。
   * 文件不存在 → 静默跳过。内容注入到 System Prompt 附近。
   */
  comdrMdPath: string;
}

/**
 * MCP Server 连接配置
 * @contract Agent 4 使用（通过 MCP client 连接外部 Agent）
 */
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * 能力提示——注入到该 server 每个 tool 的 description 前缀。
   * 帮助 LLM 理解什么时候该用、延迟预期、外部依赖。
   *
   * 示例: "生图耗时30-120s，需ComfyUI运行中"
   */
  hint?: string;
}

/**
 * Agent 行为配置
 * @contract Agent 4 消费
 */
export interface AgentBehaviorConfig {
  /** 默认 50 */
  maxTurns: number;
  /** 硬上限 */
  tokenBudget: number;
  permissionMode: PermissionMode;
}

export type PermissionMode =
  | 'auto_approve_all'
  | 'confirm_destructive'
  | 'strict';

// ============================================================================
// §7 记忆系统
// ============================================================================

/**
 * 会话状态（持久化单元）
 * @contract Agent 4 内部使用，Agent 5 通过 Engine.getSession() 读取
 */
export interface SessionState {
  id: string;
  /** 当前轮次（从 0 开始） */
  turn: number;
  /** 累计 token 用量 */
  tokensUsed: number;
  /** 用户当前输入 */
  currentInput: string;
  /** 最终结果描述 */
  outcome: string | null;
  messages: Message[];
  stateWindow: StateEntry[];
  intentWindow: IntentEntry[];
  /** 临时 ID → 真实 ID 映射（tool_call 去重，预留字段） */
  tempIdMappings: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * 会话锚点——注入 prompt 前缀，用于跨会话上下文恢复
 * @contract Agent 4 内部构造
 */
export interface SessionAnchor {
  /** 相关历史会话摘要（来自 episodic memory 检索） */
  relatedHistory: string[];
  /** 当前会话 state window 摘要 */
  stateSummary: string;
  /** 当前会话 intent window 摘要 */
  intentSummary: string;
}

// ============================================================================
// §8 进度系统
// ============================================================================

/**
 * 进度信号——每轮计算
 * @contract Agent 4 内部使用，Agent 5 通过 progress_warning event 感知
 */
export interface ProgressSignal {
  // 增益信号
  diffChanges: number;
  testDelta: number;
  infoGained: number;
  toolSuccesses: number;

  // ★ 停滞检测（Agent 4 progress.ts 必需）
  stallCount: number;          // 连续零进展轮数
  loopPattern: boolean;        // 同 tool+同 args 连续 ≥3 次
  sameFileRepeat: number;      // 同一文件连续操作次数
  emptyOutputCount: number;    // 空输出次数
  score: number;               // 综合得分（增益 - 罚分）
}

/**
 * 多维 Progress Signal 公式（README 定义）:
 *   增益 = diffChanges*2 + max(0, testDelta)*5 + infoGained
 *        + toolSuccesses*2
 *   罚分 = loopPattern?-5 + sameFileRepeat>3?-3 + emptyOutputCount*2
 *   score = 增益 + 罚分
 */

// ============================================================================
// §9 引擎/编排系统
// ============================================================================

/**
 * 运行模式
 * @contract Agent 4 → Agent 5
 */
export type RunMode = 'plan' | 'agent' | 'yolo';

/**
 * Engine.run() 返回值
 * @contract Agent 4 → Agent 5
 */
export interface RunResult {
  ok: boolean;
  turns: number;
  tokensUsed: number;
  summary: string;
  sessionId: string;
}

// ============================================================================
// §10 规划系统
// ============================================================================

/**
 * 任务类型——决定 thinking 模式选择
 * @contract Agent 4 内部使用
 */
export type TaskType =
  | 'query'
  | 'edit'
  | 'generate'
  | 'refactor'
  | 'architect'
  | 'orchestrate';

/**
 * 任务规划——Phase 2 层级任务分解
 *
 * ★ Phase 1（当前）：使用单层 Route 做工具过滤 + thinking 模式选择。
 *   规划器只返回 Route，不分解为多步骤。
 *
 * ★ Phase 2（规划中）：将用户输入分解为 PlanStep[]，
 *   按 dependencies 顺序执行，每步可有独立的 taskType 和工具白名单。
 *
 * @contract Agent 4 内部使用（Phase 2 预留）
 */
export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** 步骤间依赖: stepIndex → [依赖的 stepIndex]。★ Record 而非 Map——保证 JSON 序列化不丢失 */
  dependencies: Record<number, number[]>;
  estimatedTokens: number;
}

export interface PlanStep {
  index: number;
  description: string;
  taskType: TaskType;
  /** 预估所需工具 */
  toolsNeeded: string[];
  /** 完成标准: 一句话描述 */
  completionCriterion: string;
}

// ============================================================================
// §11 Skills 系统
// ============================================================================

/**
 * SKILL.md frontmatter 解析结果
 * @contract Agent 4 内部使用
 */
export interface SkillManifest {
  name: string;
  description: string;
  /** 触发词列表（从 frontmatter 或文件名提取） */
  triggers: string[];
  /** 正文内容（渐进式加载，初始为 null） */
  body: string | null;
  /** 文件路径 */
  filePath: string;
}

// ============================================================================
// §13 LLM 客户端系统
// ============================================================================

/**
 * LLM 调用参数
 * @contract Agent 4 → Agent 2
 */
export interface ChatParams {
  messages: Message[];
  tools?: ToolDefinition[];
  thinking: ThinkingConfig;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * LLM 调用响应
 * @contract Agent 2 → Agent 4
 */
export interface ChatResponse {
  /** ★ 必须包含 reasoning_content */
  message: Message;
  finishReason: string;
  usage: TokenUsage;
}

/**
 * Token 用量统计（DeepSeek 格式）
 * @contract Agent 2 → Agent 4，也用于日志
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek 特有 */
  reasoningTokens: number;
  /** 自动缓存命中 token 数 */
  cacheHitTokens: number;
  /** 自动缓存未命中 token 数 */
  cacheMissTokens: number;
}

// ============================================================================
// §14 路由与终止系统
// ============================================================================

/**
 * 任务路由结果——规划器输出
 * @contract Agent 4 内部使用
 */
export interface Route {
  taskType: TaskType;
  thinking: ThinkingConfig;
  allowedTools: string[];
}

/**
 * 终止原因——10 种引擎退出路径
 * @contract Agent 4 → Agent 5
 */
export type TerminationReason =
  | 'completed'
  | 'max_turns'
  | 'token_budget_exceeded'
  | 'stall_detected'
  | 'loop_detected'
  | 'scope_drift'
  | 'user_aborted'
  | 'tool_error_unrecoverable'
  | 'api_error_unrecoverable'
  | 'timeout';

// ============================================================================
// §15 上下文压缩系统
// ============================================================================

/**
 * 压缩级别
 * @contract Agent 4 内部使用
 */
export type CompactionLevel =
  | 'none'
  | 'snip_micro'   // 80%: 截断 + 微摘要
  | 'collapse'      // 90%: 折叠中间轮次
  | 'auto_compact'; // 95%: 调 LLM 压缩

/**
 * 压缩结果
 * @contract Agent 4 内部使用
 */
export interface CompactionResult {
  level: CompactionLevel;
  messagesAfter: number;
  tokensAfter: number;
  /** 压缩后注入的摘要文本 */
  injectedSummary: string | null;
}

/**
 * 结构化摘要——Factory AI 五个强制分区
 * @contract Agent 4 内部使用（context.ts ⇄ memory/episodic.ts）
 */
export interface StructuredSummary {
  /** 用户想要完成什么 */
  sessionIntent: string;
  /** ★ 最弱环节，需要特别设计 */
  fileModifications: {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    summary: string;
  }[];
  /** 架构/设计决策 */
  decisions: {
    what: string;
    why: string;
    turn: number;
  }[];
  /** 恢复时应做什么 */
  nextSteps: string[];
  /** 未解决的问题 */
  openQuestions: string[];
}

/**
 * 会话情景摘要——跨会话记忆检索单元
 * @contract Agent 4 内部使用（memory/episodic.ts）
 */
export interface EpisodeSummary {
  id: string;
  timestamp: string;
  task: string;
  outcome: string | null;
  /** 结构化摘要（重用 context.ts 输出） */
  structuredSummary: StructuredSummary | null;
  tokensUsed: number;
  turns: number;
  /** embedding 向量（检索用，不持久化到 JSON） */
  embedding?: number[];
}

// ============================================================================
// §16 反思系统
// ============================================================================

/**
 * Intra-reflection（执行前预判）结果
 * @contract Agent 4 内部使用
 */
export interface IntraReflection {
  /** 是否应该跳过该 tool call */
  skip: boolean;
  /** 跳过原因 */
  skipReason?: string;
  /** 是否应该终止整个 run */
  abort: boolean;
  /** 终止原因（abort=true 时有效） */
  abortReason?: TerminationReason;
  /** 检测到的循环模式 */
  loopDetected: boolean;
  /** 范围漂移告警 */
  scopeDrift: boolean;
  /** 非致命告警文本 */
  warning?: string;
}

/**
 * Inter-reflection（执行后审查）结果
 * @contract Agent 4 内部使用
 */
export interface InterReflection {
  /** 工具执行结果是否可接受 */
  acceptable: boolean;
  /** 是否需要回滚 */
  needsRollback: boolean;
  /** 反馈给 LLM 的纠正信息（注入下一轮 messages） */
  feedback: string | null;
  /** 错误分类（用于 Failure Pattern Graph） */
  errorCategory?: ErrorCategory;
  /** 检测到的根因 */
  rootCause?: string;
}

// ============================================================================
// §17 命名规范——事件类型常量
// ============================================================================

/**
 * AgentEvent.type 的所有合法值
 * 用此常量对象代替硬编码字符串，保证编译期检查
 *
 * 使用示例:
 *   emit({ type: AGENT_EVENT.TEXT_DELTA, content: 'hello' })
 *
 * @contract 所有 Agent 使用此常量，禁止硬编码事件名字符串
 */
export const AGENT_EVENT = {
  TEXT_DELTA: 'text_delta',
  THINKING_DELTA: 'thinking_delta',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  PROGRESS_WARNING: 'progress_warning',
  SESSION_STARTED: 'session_started',
  TURN_BEGIN: 'turn_begin',
  TOKEN_USAGE: 'token_usage',
  MCP_STATUS: 'mcp_status',
  DONE: 'done',
  ERROR: 'error',
} as const;

/**
 * ToolPermission 的所有合法值
 */
export const TOOL_PERMISSION = {
  READ_ONLY: 'read_only',
  DESTRUCTIVE: 'destructive',
  REQUIRES_APPROVAL: 'requires_approval',
} as const;

/**
 * PermissionMode 的所有合法值
 */
export const PERMISSION_MODE = {
  AUTO_APPROVE_ALL: 'auto_approve_all',
  CONFIRM_DESTRUCTIVE: 'confirm_destructive',
  STRICT: 'strict',
} as const;

/**
 * RunMode 的所有合法值
 */
export const RUN_MODE = {
  PLAN: 'plan',
  AGENT: 'agent',
  YOLO: 'yolo',
} as const;

/**
 * TaskType 的所有合法值
 */
export const TASK_TYPE = {
  QUERY: 'query',
  EDIT: 'edit',
  GENERATE: 'generate',
  REFACTOR: 'refactor',
  ARCHITECT: 'architect',
  ORCHESTRATE: 'orchestrate',
} as const;

/**
 * Thinking effort 的所有合法值
 */
export const THINKING_EFFORT = {
  HIGH: 'high',
  MAX: 'max',
} as const;

/**
 * Thinking 开关的所有合法值
 *
 * DeepSeek V4: thinking.type 必须是 'enabled' 或 'disabled'。
 * 启用时需配合 THINKING_EFFORT 使用。
 */
export const THINKING_TYPE = {
  ENABLED: 'enabled',
  DISABLED: 'disabled',
} as const;

/**
 * MessageRole 的所有合法值
 *
 * @contract 所有 Agent 使用此常量，禁止硬编码 'system' / 'user' / 'assistant' / 'tool'
 */
export const MESSAGE_ROLE = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
} as const;

/**
 * MCPServerStatus 的所有合法值
 *
 * @contract Agent 4（mcp-client）和 Agent 5（TUI 渲染）使用此常量
 */
export const SERVER_STATUS = {
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  OFFLINE: 'offline',
  ERROR: 'error',
} as const;

/**
 * ErrorCategory 的所有合法值——工具错误的唯一分类维度
 *
 * @contract Agent 3（SDB 返回）、Agent 4（reflection.inter 消费）、Agent 5（渲染）
 */
export const ERROR_CATEGORY = {
  SCHEMA_INVALID: 'schema_invalid',
  PERMISSION_DENIED: 'permission_denied',
  TIMEOUT: 'timeout',
  FILE_NOT_FOUND: 'file_not_found',
  TEST_FAILED: 'test_failed',
  DIFF_MISMATCH: 'diff_mismatch',
  SNAPSHOT_FAILED: 'snapshot_failed',
  ROLLBACK_FAILED: 'rollback_failed',
  EXECUTION_ERROR: 'execution_error',
} as const;

/**
 * TerminationReason 的所有合法值——10 种引擎退出路径
 *
 * @contract Agent 4 → Agent 5
 */
export const TERMINATION_REASON = {
  COMPLETED: 'completed',
  MAX_TURNS: 'max_turns',
  TOKEN_BUDGET_EXCEEDED: 'token_budget_exceeded',
  STALL_DETECTED: 'stall_detected',
  LOOP_DETECTED: 'loop_detected',
  SCOPE_DRIFT: 'scope_drift',
  USER_ABORTED: 'user_aborted',
  TOOL_ERROR_UNRECOVERABLE: 'tool_error_unrecoverable',
  API_ERROR_UNRECOVERABLE: 'api_error_unrecoverable',
  TIMEOUT: 'timeout',
} as const;

/**
 * 系统范围常量
 */
export const SYSTEM = {
  /** State Window 最大条目数 */
  MAX_STATE_WINDOW_SIZE: 5,
  /** Intent Window 最大条目数 */
  MAX_INTENT_WINDOW_SIZE: 5,
  /** 默认最大轮次 */
  DEFAULT_MAX_TURNS: 50,
  /** 默认 token 预算 */
  DEFAULT_TOKEN_BUDGET: 200_000,
  /** 上下文压缩触发阈值 */
  COMPACTION_THRESHOLD_SNIP: 0.8,
  COMPACTION_THRESHOLD_COLLAPSE: 0.9,
  COMPACTION_THRESHOLD_COMPACT: 0.95,
  /** Progress Meter 连续零进展轮次 → abort */
  MAX_STALLED_TURNS: 2,
  /** 日志旋转阈值（字节） */
  LOG_ROTATION_SIZE: 500_000,
  /** LLM 重试: 最大次数 */
  LLM_MAX_RETRIES: 3,
  /** LLM 重试: 初始退避毫秒 */
  LLM_RETRY_BASE_MS: 1000,
  /** 上下文压缩 drainLine 比例 */
  COMPACTION_THRESHOLD_DRAIN: 0.6,
  /** 默认工具超时毫秒 */
  DEFAULT_TOOL_TIMEOUT_MS: 30_000,
  /** 反射调用签名历史上限 */
  MAX_CALL_SIGNATURES: 6,
  /** 连续相同调用 → 循环判定阈值（progress + reflection 共享） */
  LOOP_DETECTION_THRESHOLD: 3,
  /** Progress: 多少轮零进展后 escalate 到 abort */
  STALL_ABORT_THRESHOLD: 3,
  /** 全局执行超时（毫秒），0 = 无限制 */
  GLOBAL_TIMEOUT_MS: 300_000,
  /** 摘要文本截断长度 */
  SUMMARY_MAX_LENGTH: 200,
  /** 摘要 LLM 输入最大字符数 */
  SUMMARY_INPUT_MAX_CHARS: 8000,
  /** 摘要 LLM maxTokens */
  SUMMARY_LLM_MAX_TOKENS: 2000,
  /** 完整压缩 LLM maxTokens */
  FULL_COMPACT_MAX_TOKENS: 4000,
  /** openQuestions 上限 */
  MAX_OPEN_QUESTIONS: 10,
  /** nextSteps 上限（与 MAX_OPEN_QUESTIONS 独立管理） */
  MAX_NEXT_STEPS: 10,
  /** 每条消息 token 估算 overhead（字符） */
  MSG_OVERHEAD_CHARS: 50,
  /** token 估算比例（字符/Token） */
  CHARS_PER_TOKEN_ESTIMATE: 4,
  /** 默认 HTTP 端口 */
  DEFAULT_PORT: 3000,
  /** 运行时 skill 默认超时毫秒 */
  DEFAULT_SKILL_TIMEOUT_MS: 60_000,
  /** 展开后 skill 默认超时毫秒 */
  EXPANDED_SKILL_TIMEOUT_MS: 120_000,
  /** 工作台文本截断长度 */
  WORKING_TEXT_MAX_LENGTH: 100,
  /** deriveKey cmd 截断长度 */
  DERIVE_KEY_CMD_LENGTH: 30,
  /** deriveKey args 截断长度 */
  DERIVE_KEY_ARGS_LENGTH: 40,
  /** 意图提取最大长度 */
  INTENT_EXTRACT_MAX_LENGTH: 60,

  // ---- 上下文压缩阈值 ----
  /** Stage 1 观察掩码保留的最近轮数 */
  COMPACTION_OBSERVE_MASK_TURNS: 5,
  /** 结构化摘要 fileModifications 最大条目数 */
  COMPACTION_MAX_FILE_MODIFICATIONS: 20,
  /** 结构化摘要 decisions 最大条目数 */
  COMPACTION_MAX_DECISIONS: 15,

  // ---- Prompt 构造 ----
  /** L6 最近历史保留的对话轮数 */
  PROMPT_RECENT_HISTORY_TURNS: 5,

  // ---- 记忆系统 ----
  /** 情景记忆 embedding 维度 */
  EPISODIC_EMBEDDING_DIMS: 200,
  /** 情景记忆检索返回数 */
  EPISODIC_RETRIEVAL_TOPK: 3,
  /** 语义记忆最近文件查询默认数 */
  SEMANTIC_RECENT_FILES_K: 10,
  /** 情景记忆中间快照间隔（轮），0 = 仅在会话结束时保存 */
  EPISODIC_SNAPSHOT_INTERVAL: 10,
} as const;

/**
 * 全部工具哨兵值——route.allowedTools 中包含此值时表示所有工具可用
 */
export const ALL_TOOLS_SENTINEL = 'all' as const;

/**
 * 上下文掩码前缀——标记被压缩的 tool result
 */
export const MASKED_PREFIX = '[masked]' as const;
