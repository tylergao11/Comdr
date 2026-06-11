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
  LSPFileContext,
  DiagnosticSnapshot,
  DiagnosticDelta,
  LSPDiagnostic,
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
   *
   * @param onEvent 在每次 SSE chunk 到达时同步调用的回调。
   *                回调抛出的异常会被 chatStream() 捕获并导致返回的 Promise 以该异常 rejected。
   *                调用者应保证 onEvent 不抛出——或者在外部 catch 中处理拒绝。
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
   * ★ 当前为同步调用（napi-rs 绑定）。未来若需要异步工具（如 HTTP MCP 调用），
   *   将签名改为 ToolResult | Promise<ToolResult>，消费者在 loop.ts 中统一 await。
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
   * @param sessionId  可选——恢复已有会话的 ID。
   *                   空串 "" 和 undefined 等价（视为无恢复），
   *                   实现层应统一做 `sessionId || undefined` 归一化。
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
   * ★ 热更新重载配置——仅重新加载非破坏性字段，不重启引擎。
   *
   * 可热更新的字段:
   *   - agent.maxTurns
   *   - agent.tokenBudget
   *   - agent.permissionMode
   *   - project.comdrMdPath
   *   - project.contextModel
   *
   * 不可热更新（需要重启引擎）:
   *   - llm.*              （LLM 客户端已实例化，无法动态切换）
   *   - project.mcpServers （MCP 连接已建立，无法动态变更）
   *   - project.projectPath（引擎根路径，初始化后不可变）
   *
   * @throws ConfigValidationError 热更新后的配置不合法时抛出
   */
  reload(): AgentConfig;
}

/**
 * 配置验证错误。
 *
 * `errors` 字段格式统一为 `${section}.${field} (${reason})` 形式的错误描述列表。
 * 例: `"llm.apiKey (required)"`, `"llm.thinking.type (must be 'enabled' or 'disabled')"`。
 * 所有构造者必须遵守此格式。
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[],
  ) {
    super(message);
    this.name = 'ConfigValidationError';
    // ★ 字段名从 missingFields 改为 errors——此字段不仅包含缺失字段，
    //   也包含格式错误、类型错误等。统一命名避免调用方混淆。
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
// Contract F1: VS Code Fork → @comdr/vscode (Terminal 1 → Terminal 2)
// ============================================================================

/**
 * Shadow Workspace 契约——隔离的编辑器窗口 + 独立 LSP 实例
 *
 * @contract
 *   实现者: Terminal 1 — VS Code OSS Fork（3 个最小化 patch）
 *   消费者: Terminal 2 — @comdr/vscode/src/shadow-workspace.ts
 *
 * @semantic
 *   1. create() 创建一个隐藏 Electron BrowserWindow，加载当前工作区
 *   2. 隐藏窗口拥有独立的 LSP Server 实例——不和用户窗口共享
 *   3. applyEdit() 写入文件内容到隐藏窗口（不触发用户侧 LSP）
 *   4. getDiagnostics() 从隐藏窗口的独立 LSP 实例获取诊断
 *   5. getFileContext() 聚合多个 LSP 调用，返回完整语义上下文
 *   6. mergeToUser() 将验证通过的修改合并到用户可见的编辑器
 *   7. dispose() 销毁隐藏窗口，释放资源
 *   8. 隐藏窗口 15 分钟无活动自动销毁（参考 Cursor 设计）
 *
 * @design
 *   这是 Comdr 深度集成的核心差异化能力。
 *   等价于 DeepSeek 适配中的 reasoning_content 保留回传——
 *   都是利用平台独有能力，不通过通用抽象层。
 *
 *   为什么必须 Fork:
 *   - VS Code Extension API 无法创建隐藏编辑器窗口
 *   - VS Code Extension API 无法启动独立 LSP 实例
 *   - 跨文件语义（Go 同名声明、Rust 显式 import）需要完整 IDE 实例
 */
export interface IShadowWorkspace {
  /**
   * 为项目创建隐藏编辑窗口
   * @param projectPath 项目根目录（绝对路径）
   * @returns 窗口 ID（后续操作的句柄）
   */
  create(projectPath: string): string;

  /**
   * 在隐藏窗口中写入/修改文件内容
   * 不触发用户侧 LSP，只在隐藏窗口内生效
   * @param windowId create() 返回的窗口 ID
   * @param filePath 相对于项目根的文件路径
   * @param content 完整的文件新内容
   */
  applyEdit(windowId: string, filePath: string, content: string): void;

  /**
   * 获取隐藏窗口中文件的 LSP 诊断
   * @returns 当前所有 LSP 诊断列表
   */
  getDiagnostics(windowId: string, filePath: string): LSPDiagnostic[];

  /**
   * ★ 获取文件的完整 LSP 语义上下文
   * 聚合 documentSymbol + hover + references + callHierarchy + typeHierarchy
   *
   * ★ LSAP 论文: 1 次调用替代 12 次 LSP 原子操作
   */
  getFileContext(windowId: string, filePath: string): LSPFileContext;

  /**
   * 将隐藏窗口中验证通过的修改合并到用户窗口
   * 合并后用户在编辑器中看到 diff，可以 Accept/Reject
   * @param windowId create() 返回的窗口 ID
   * @param filePath 要合并的文件路径
   */
  mergeToUser(windowId: string, filePath: string): void;

  /**
   * 销毁隐藏窗口，释放所有资源（LSP 进程、内存、文件副本）
   */
  dispose(windowId: string): void;
}

// ============================================================================
// Contract F2: @comdr/vscode → @comdr/engine (Terminal 2 → Terminal 3)
// ============================================================================

/**
 * LSP 桥接契约——Engine 通过此接口消费 LSP 语义信息
 *
 * @contract
 *   实现者: Terminal 2 — @comdr/vscode/src/lsp-bridge.ts
 *   消费者: Terminal 3 — @comdr/engine (prompt.ts + reflection.ts + world-model.ts)
 *
 * @semantic
 *   1. getFileContext() 返回文件的完整 LSP 语义上下文
 *      - Phase 1: 通过 VS Code Extension API (vscode.languages.getDiagnostics 等)
 *      - Phase 3: 直连 LSP 进程（Patch 2 lsp-bridge-ipc）
 *   2. snapshotDiagnostics() 记录某一时刻的诊断状态
 *   3. diffDiagnostics() 计算两次快照的诊断差值
 *   4. 所有方法是异步的——LSP 查询可能跨进程通信
 *
 * @design
 *   这个接口是 Engine 改造的唯一外部依赖。
 *   Terminal 3 开发时用 mock ILSPBridge 进行单元测试，
 *   不依赖 Terminal 1 (Fork) 和 Terminal 2 (Extension) 的完整实现。
 */
export interface ILSPBridge {
  /**
   * 获取文件的 LSP 语义上下文
   * ★ 用于 prompt.ts L1.5 层注入 + world-model.ts LSP 语义管道
   *
   * @param filePath 文件绝对路径
   * @returns 完整 LSP 上下文，文件未打开或 LSP 不可用时返回 null
   * @throws LSPConnectionError LSP 连接不可用时抛出
   */
  getFileContext(filePath: string): Promise<LSPFileContext | null>;

  /**
   * 创建文件的 LSP 诊断快照
   * ★ 用于 reflection.ts: Agent 操作前后各拍一次 → diffDiagnostics
   *
   * @param filePath 文件绝对路径
   * @returns 诊断快照（含文件内容哈希 + 诊断列表 + 时间戳）
   * @throws LSPConnectionError 文件无法打开或 LSP 未就绪时抛出（不返回 null）
   */
  snapshotDiagnostics(filePath: string): Promise<DiagnosticSnapshot>;

  /**
   * 计算两次诊断快照的差值
   * ★ 确定性纯函数——Engine 侧可独立测试
   *
   * @param before Agent 操作前的快照
   * @param after  Agent 操作后的快照
   * @returns 诊断差值（introduced / fixed / unchanged）
   */
  diffDiagnostics(before: DiagnosticSnapshot, after: DiagnosticSnapshot): DiagnosticDelta;
}

/**
 * LSP 桥接抛出的错误——LSP 连接不可用或文件无法打开时抛出。
 * 区别于 Engine 侧的 reflection.ts: 此处负责抛出，Engine 侧负责 catch 并降级。
 */
export class LSPConnectionError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    /** 底层原因（如文件 I/O 错误），不覆盖 Error.cause 以避免 TS 4115 */
    public readonly innerCause?: Error,
  ) {
    super(message);
    this.name = 'LSPConnectionError';
  }
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

// ============================================================================
// Contract F: 子智能体 → 主引擎
// ============================================================================

/**
 * 子智能体清单——主引擎发现和注册的依据。
 *
 * @contract
 *   实现者: 各子智能体包（@comdr/audit、@comdr/cocos-engine 等）
 *   消费者: Agent 4（@comdr/engine）
 */
export interface SubAgentManifest {
  /** 唯一标识，如 "audit"、"cocos-engine" */
  name: string;
  /** 一句话描述——LLM 选择子智能体时的依据 */
  description: string;
  /** 语义版本 */
  version: string;
  /** 工具名前缀——子智能体的工具注册为 "name__toolName" */
  toolPrefix: string;
}

/**
 * 子智能体契约——任何子智能体包必须导出 createSubAgent() 工厂函数。
 *
 * 设计原则:
 *   - 子智能体是工具提供者，不是独立进程。
 *   - 主引擎通过 ISubAgent 接口发现工具并分发调用。
 *   - 子智能体内部可以是无状态函数（audit）或有状态 Gateway（cocos-engine）。
 *
 * @contract
 *   实现者: 各子智能体包
 *   消费者: Agent 4 的 SubAgentRegistry
 */
export interface ISubAgent {
  /** 清单信息 */
  readonly manifest: SubAgentManifest;

  /** 返回子智能体提供的工具定义列表 */
  getTools(): import('./types.js').ToolDefinition[];

  /**
   * 执行工具调用。
   *
   * @param toolName  工具名（不含前缀——registry 已剥离）
   * @param args      工具参数
   * @returns         工具执行结果
   */
  executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<import('./types.js').ToolResult>;
}

/**
 * 子智能体工具执行结果——executeTool() 返回。
 * 不含 callId/toolName——由 SubAgentRegistry 填充。
 */
export interface SubAgentToolResult {
  ok: boolean;
  content: string | null;
  errorCategory?: import('./types.js').ErrorCategory;
}

/**
 * 子智能体工厂函数签名——每个子智能体包必须导出。
 *
 * @example
 *   // 在 @comdr/audit 中:
 *   export const createSubAgent: SubAgentFactory = (config) => new AuditSubAgent(config);
 */
export type SubAgentFactory = (config: Record<string, unknown>) => ISubAgent;
