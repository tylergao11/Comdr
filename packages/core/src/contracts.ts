/**
 * contracts.ts — Agent 间边界接口契约
 *
 * 此文件定义每个 Agent 必须实现的公开接口（契约）。
 * 契约 = 类型签名 + 语义保证。违反契约 = 集成失败。
 *
 * ## 契约矩阵
 *
 *   Contract A: IDeepSeekClient   → Agent 2 实现，Agent 4 消费
 *   Contract B: INativeTools      → Agent 3 实现，Agent 4 消费
 *   Contract C: IEngine           → Agent 4 实现，Agent 5 消费
 *   Contract D: IConfigLoader     → Agent 1 实现，入口代码消费（AgentConfig 注入 Agent 2/4）
 *   Contract E: IEventLogger      → Agent 1 实现，Agent 4 消费
 *
 * ## 依赖方向
 *
 *   Agent 1 (core)      ← 无依赖（只定义类型）
 *   Agent 2 (llm)       ← 依赖 Contract D（读配置）, Contract E（写日志）
 *   Agent 3 (tools)     ← 无 TS 依赖（Rust 独立，napi 导出对齐 Contract B）
 *   Agent 4 (engine)    ← 依赖 Contract A + B + D + E（集成点）
 *   Agent 5 (ui)        ← 依赖 Contract C（展示面）
 *
 * ## Mock 规则
 *
 * 每个 Agent 的单元测试应 mock 它消费的 Contract，不 mock 未导出的内部实现。
 * 例如: Agent 4 测试 mock IDeepSeekClient + INativeTools，不 mock MemorySystem。
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护
 */

import type {
  AgentConfig,
  AgentEvent,
  ChatParams,
  ChatResponse,
  RunMode,
  RunResult,
  SessionState,
  ToolDefinition,
  ToolExecuteOptions,
  ToolResult,
} from './types.js';

// ============================================================================
// Contract A: Agent 2 → Agent 4
// ============================================================================

/**
 * DeepSeek LLM 客户端契约
 *
 * @contract
 *   实现者: Agent 2 (packages/llm)
 *   消费者: Agent 4 (packages/engine)
 *
 * @semantic
 *   1. chat() 和 chatStream() 必须保证 reasoning_content 在原样 Message 中返回
 *   2. thinking 参数作为顶层字段发送，不是 extra_body
 *   3. thinking 启用时，不发送 tool_choice / temperature / top_p
 *   4. 429/5xx → 指数退避 1s→2s→4s，max 3 次
 *   5. 401/403 → 不重试，直接抛
 *   6. chatStream() 的 onEvent 回调中，text_delta 和 thinking_delta 各自独立推送
 *   7. 工具定义序列化时 sort_keys 保证前缀缓存命中
 *   8. 不发送 cache_control 标记（DeepSeek 自动前缀缓存）
 */
export interface IDeepSeekClient {
  /**
   * 非流式调用
   * @throws DeepSeekAuthError  (401/403)
   * @throws DeepSeekRetryError (429/5xx, 重试耗尽后)
   */
  chat(params: ChatParams): Promise<ChatResponse>;

  /**
   * 流式调用（SSE）
   * onEvent 在每个 SSE chunk 到达时同步调用。
   * ★ reasoning_content 片段以 thinking_delta 事件推送。
   * @throws 同 chat()
   */
  chatStream(
    params: ChatParams,
    onEvent: (event: AgentEvent) => void,
  ): Promise<ChatResponse>;
}

/**
 * Agent 2 抛出的错误类型
 * @contract Agent 2 → Agent 4
 */
export class DeepSeekAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403,
  ) {
    super(message);
    this.name = 'DeepSeekAuthError';
  }
}

export class DeepSeekRetryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'DeepSeekRetryError';
  }
}

// ============================================================================
// Contract B: Agent 3 → Agent 4
// ============================================================================

/**
 * 原生工具执行层契约（napi-rs 桥接）
 *
 * @contract
 *   实现者: Agent 3 (crates/comdr-tools)
 *   消费者: Agent 4 (packages/engine)
 *
 * @semantic
 *   1. execute() 内部运行 SDB 6 步管线:
 *      Step 1: Schema Validate — JSON Schema 校验参数
 *      Step 2: Permission Check — 权限检查
 *      Step 3: Pre-snapshot  — 破坏性操作前拍快照
 *      Step 4: Execute       — 带超时执行
 *      Step 5: Diff Validate — 实际变更 vs 预期对比
 *      Step 6: Test Feedback — 自动跑受影响测试
 *         → 测试失败 → 自动回滚到 Step 3 快照
 *   2. rollback() 将文件恢复到指定快照状态
 *   3. listTools() 返回的工具定义必须与 execute() 实际支持的严格一致
 *   4. 所有文件路径使用正斜杠（与 OS 无关）
 *   5. napi-rs 层负责 Rust ↔ TS 类型转换，不暴露 Rust 类型到 TS 侧
 */
export interface INativeTools {
  /**
   * 执行工具（SDB 6 步管线）
   *
   * @param opts.name              工具名
   * @param opts.callId            LLM tool call ID（原样回传）
   * @param opts.arguments         参数对象（已由 SDB Step 1 外的 Schema Validate 预检）
   * @param opts.timeoutMs         超时毫秒
   * @returns ToolResult           直接返回完整结果（含 callId + toolName）
   */
  execute(opts: ToolExecuteOptions): ToolResult;

  /**
   * 回滚到指定快照（恢复文件 + 移除快照）
   * @returns true = 回滚成功
   */
  rollback(snapshotId: string): boolean;

  /**
   * 丢弃快照（仅移除，不恢复文件）。
   * 用于 self-correct 成功后清理不再需要的原始快照。
   * @returns true = 移除成功
   */
  discardSnapshot(snapshotId: string): boolean;

  /**
   * 列出所有注册工具的定义
   * 返回结果与 execute() 实际支持的工具严格一致
   */
  listTools(): ToolDefinition[];
}

// ============================================================================
// Contract C: Agent 4 → Agent 5
// ============================================================================

/**
 * 引擎契约
 *
 * @contract
 *   实现者: Agent 4 (packages/engine)
 *   消费者: Agent 5 (packages/ui)
 *
 * @semantic
 *   1. run() 返回 AsyncGenerator——Agent 5 逐事件消费
 *   2. Agent 5 通过 for await 消费事件流，事件顺序 = 执行顺序
 *   3. 事件流结束前必定有一个 done 或 error 事件作为最后一个事件
 *   4. getSession() 返回当前会话完整状态，用于会话保存/恢复
 *   5. resumeSession() 恢复历史会话的 messages + state window + intent window
 */
export interface IEngine {
  /**
   * ★ 主入口——执行用户输入
   *
   * @param userInput  用户输入的自然语言请求
   * @param mode       运行模式: plan(只读) | agent(逐步确认) | yolo(全自动)
   * @param sessionId  可选——恢复已有会话的 ID
   * @returns          事件流（AsyncGenerator，Agent 5 逐事件消费）
   *
   * 使用方式:
   *   const engine = new Engine(...);
   *   for await (const event of engine.run("创建 hello.ts", "agent")) {
   *     ui.render(event);
   *   }
   */
  run(
    userInput: string,
    mode: RunMode,
    sessionId?: string,
  ): AsyncGenerator<AgentEvent, RunResult, void>;

  /**
   * 获取当前会话完整状态
   */
  getSession(): SessionState;

  /**
   * 恢复已有会话
   * 恢复 messages + state window + intent window + tempId 映射
   */
  resumeSession(sessionId: string): Promise<SessionState>;

  /**
   * 中断当前执行
   */
  abort(): void;
}

// ============================================================================
// Contract D: Agent 1 → 所有 Agent
// ============================================================================

/**
 * 配置加载契约
 *
 * @contract
 *   实现者: Agent 1 (packages/core)
 *   消费者: Agent 2,4（读配置）, Agent 5（可选）
 *
 * @semantic
 *   1. 加载优先级: 环境变量 > ./.comdr.toml > ~/.comdr/config.toml > 硬编码默认值
 *   2. 合并策略: 浅合并，高优先级字段完全覆盖低优先级
 *   3. 验证: 必填字段缺失 → 抛 ConfigValidationError
 *   4. process.env.COMDR_API_KEY 映射到 llm.apiKey
 */
export interface IConfigLoader {
  /**
   * 加载并验证配置
   * @param projectPath 项目根目录
   * @throws ConfigValidationError 配置无效时
   */
  load(projectPath: string): AgentConfig;

  /**
   * 重新加载（热更新，仅非破坏性字段）
   */
  reload(): AgentConfig;
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly missingFields: string[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

// ============================================================================
// Contract E: Agent 1 → Agent 2,4
// ============================================================================

/**
 * 事件日志契约
 *
 * @contract
 *   实现者: Agent 1 (packages/core)
 *   消费者: Agent 2（记录 LLM 调用）, Agent 4（记录执行事件）
 *
 * @semantic
 *   1. 每行一个 JSON（JSONL），每个 AgentEvent 序列化为一行
 *   2. 输出路径: {projectPath}/temp/comdr/execution-{date}.jsonl
 *   3. Token 统计: {projectPath}/temp/comdr/latest-tokens.json
 *   4. 日志旋转: >500KB → 保留末 1000 行
 */
export interface IEventLogger {
  /** 写入一个事件 */
  log(event: AgentEvent): void;

  /** 写入 token 统计 */
  logTokens(usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  }): void;

  /** 返回当前日志文件路径 */
  getLogPath(): string;
}

// ============================================================================
// 契约验证辅助
// ============================================================================

/**
 * 契约验证——Agent 间集成测试的工具函数
 *
 * 每个 Agent 导出此函数的实现，用于集成前自检:
 *   import { verifyContract } from '@comdr/core/contracts';
 *   const result = myAgent.verifyContract();
 *   // result.passes === true 表示满足契约
 */
export interface ContractVerification {
  /** 契约名称 */
  contract: string;
  /** 是否通过 */
  passes: boolean;
  /** 未通过的检查项（passes=true 时为空） */
  failures: string[];
}

/**
 * 每个 Agent 模块必须导出的契约自检函数
 */
export type ContractVerifier = () => ContractVerification;
