/**
 * loop.ts — 单线程 Master Loop
 *
 * 来源：Claude Code queryLoop() + SWE-agent ReAct 模式 + BOAD 层级路由
 *
 * 主循环流程（每轮 9 步）:
 *   1. prompt.build()          分层构造（固定前缀保证缓存命中）
 *   2. planner.route()         ★ 层级路由：任务类型 → thinking 模式
 *   3. reasoning.inject()      ★ reasoning_content 注入 messages
 *   4. llm.chatStream()        调用 DeepSeek
 *   5. if text                 → 流式输出, done
 *   6. if tool_calls            → for each:
 *      a. reflection.intra()   规则驱动的执行前预判
 *      b. tools.execute()      → SDB 6步 (Agent 3)
 *      c. reasoning.capture()  ★ reasoning_content 捕获
 *      d. reflection.inter()   执行后审查（失败时调 LLM）
 *      e. memory.update()      双窗口增量更新
 *   7. progress.measure()      多维 progress signal
 *      → 检测停滞 → abort
 *   8. context.compact()       ★ 结构化锚定迭代摘要
 *   9. loop
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  AgentEvent,
  AgentConfig,
  Message,
  RunMode,
  RunResult,
  SessionState,
  ToolCall,
  ToolResult,
  TerminationReason,
  ToolExecuteOptions,
  MCPServerStatus,
} from '@comdr/core/types';
import {
  AGENT_EVENT,
  SYSTEM,
  MESSAGE_ROLE,
  THINKING_TYPE,
  THINKING_EFFORT,
  TERMINATION_REASON,
  ERROR_CATEGORY,
} from '@comdr/core';
import type {
  IDeepSeekClient,
  INativeTools,
  IEventLogger,
  IEngine,
  ILSPBridge,
} from '@comdr/core/contracts';
import { DeepSeekAuthError, DeepSeekRetryError } from '@comdr/core/contracts';

import { ReasoningManager } from './reasoning.js';
import { PromptConstructor, anchorFromWindows } from './prompt.js';
import { ContextManager } from './context.js';
import { WorkingMemory } from './memory/working.js';
import { EpisodicMemory } from './memory/episodic.js';
import { SemanticMemory } from './memory/semantic.js';
import { ToolExperienceMemory } from './memory/tool-experience.js';
import type { ToolExperience } from './memory/tool-experience.js';
import { SkillEvolution } from './memory/skill-evolution.js';
import { TaskPlanner } from './planner.js';
import { SubAgentRegistry } from './subagent-registry.js';
import { ReflectionEngine } from './reflection.js';
import { ProgressMeter } from './progress.js';
import { SkillsLoader } from './skills.js';
import { SessionStore } from './persistence.js';
import { MCPClient } from './mcp-client.js';
import { safeParseArgs } from './utils.js';
import { summarizeDiff } from './smart-truncate.js';
import { discoverComdrMd } from './world-model.js';
import { generateRepoMap } from './repo-map.js';
import { builtinRules, type CheckRule, type CheckContext, invalidateFileCache } from './self-check.js';
import { isAdvancedTool, executeAdvancedTool } from './tools/execute.js';
import type { ToolExecContext } from './tools/execute.js';
import { scheduleParallel } from './scheduler.js';
import { compileBlueprint } from './tool-blueprint/index.js';
import type { ToolBlueprint } from '@comdr/core';
import { bootstrapProject } from '@comdr/tools';
import type { BootstrapReport } from '@comdr/tools';
import { resolve as pathResolve } from 'node:path';

// ============================================================================
// §1 Engine 类
// ============================================================================

export class Engine implements IEngine {
  // 注入的依赖
  private readonly llm: IDeepSeekClient;
  private readonly contextLLM: IDeepSeekClient | undefined;
  private readonly tools: INativeTools | null;
  private readonly logger: IEventLogger | null;
  private readonly config: AgentConfig;

  // 子系统
  private readonly reasoning: ReasoningManager;
  private readonly prompt: PromptConstructor;
  private readonly context: ContextManager;
  private readonly workingMemory: WorkingMemory;
  private readonly episodicMemory: EpisodicMemory;
  private readonly semanticMemory: SemanticMemory;
  private readonly toolExperience: ToolExperienceMemory;
  private readonly skillEvolution: SkillEvolution;
  private readonly planner: TaskPlanner;
  private readonly subAgentRegistry: SubAgentRegistry;
  private readonly reflection: ReflectionEngine;
  private readonly progress: ProgressMeter;
  private readonly skillsLoader: SkillsLoader;
  private readonly sessionStore: SessionStore;
  private readonly mcpClient: MCPClient | null;

  /** ★ LSP 桥接（VS Code Extension 注入，CLI 模式下为 null 静默降级） */
  private lspBridge: ILSPBridge | null = null;

  // 运行时状态
  private session: SessionState | null = null;
  private abortController: AbortController | null = null;
  /** ★ 上一轮的静态区指纹——用于检测前缀缓存是否失效 */
  private lastStaticFingerprint: string | null = null;
  /** Skills 加载日志，在 run() 启动时 yield */
  private skillsLog: string | null = null;
  /** ★ Bootstrap 结果——构造时完成，run() 时 yield 事件 */
  private bootstrapReport: BootstrapReport | null = null;
  /** ★ 自检规则集 */
  private readonly checkRules: CheckRule[];
  /** ★ 已发出的自检消息——去重用（同文件同规则同偏离不重复） */
  private readonly emittedIssues: Set<string> = new Set();
  /** ★ 自检文件内容缓存——避免同 session 重复 IO */
  private readonly fileCache: Map<string, string> = new Map();
  /** ★ session 内新创建的文件路径——补充到 allFiles */
  private sessionFiles: Set<string> = new Set();
  /** ★ Tool Blueprint——工具世界模型拓扑图，同会话内静态 */
  private blueprint: ToolBlueprint | null = null;
  /** ★ 最近一次收集的完整工具列表——tool_explore 展开时查找 */
  private allTools: import('@comdr/core/types').ToolDefinition[] = [];
  /** ★ 待确认的工具调用——key=callId, value=resolve(approved) */
  private pendingConfirms: Map<string, (approved: boolean) => void> = new Map();

  constructor(
    llm: IDeepSeekClient,
    config: AgentConfig,
    tools: INativeTools | null = null,
    logger: IEventLogger | null = null,
    /** ★ 可选上下文专用 LLM——压缩/摘要/反思任务优先使用。推荐 flash 模型。 */
    contextLLM?: IDeepSeekClient,
  ) {
    this.llm = llm;
    this.contextLLM = contextLLM;
    this.tools = tools;
    this.logger = logger;
    this.config = config;

    // 初始化子系统
    this.reasoning = new ReasoningManager();
    this.prompt = new PromptConstructor();
    this.context = new ContextManager(llm, contextLLM);
    this.workingMemory = new WorkingMemory();
    this.episodicMemory = new EpisodicMemory();
    this.semanticMemory = new SemanticMemory();
    this.toolExperience = new ToolExperienceMemory();
    this.skillEvolution = new SkillEvolution();
    this.planner = new TaskPlanner();
    this.subAgentRegistry = new SubAgentRegistry();
    this.reflection = new ReflectionEngine(llm);
    this.progress = new ProgressMeter();
    this.skillsLoader = new SkillsLoader();
    this.sessionStore = new SessionStore(config.project.projectPath);

    // ★ 自检管线——内置规则（未来可从 COMDR.md / skills 加载）
    this.checkRules = [...builtinRules];

    // ★ 从磁盘恢复跨会话记忆（不存在/损坏 → 静默降级）
    const epData = this.sessionStore.loadEpisodic();
    if (epData) this.episodicMemory.deserialize(epData);
    const semData = this.sessionStore.loadSemantic();
    if (semData) this.semanticMemory.deserialize(semData);

    // MCP 客户端——有配置的 server 才初始化
    this.mcpClient =
      config.project.mcpServers.length > 0
        ? new MCPClient(config.project.mcpServers)
        : null;

    // ★ COMDR.md — 多源自动发现（全局 + world-models + 项目根目录）
    this.prompt.setComdrMd(
      discoverComdrMd(
        config.project.projectPath,
        config.project.comdrMdPath || 'COMDR.md',
      ),
    );

    // ★ Project path — 告诉 LLM 项目在哪，不再幻觉路径
    this.prompt.setProjectPath(config.project.projectPath);

    // ★ 扫描 skills 目录，注册所有 SKILL.md（渐进式加载）
    const skillsDir = pathResolve(
      config.project.projectPath,
      config.project.skillsDir || SYSTEM.DEFAULT_SKILLS_DIR,
    );
    const skillsCount = this.skillsLoader.scanDirectory(skillsDir);
    if (skillsCount > 0) {
      this.skillsLog = `Loaded ${skillsCount} skills from ${config.project.skillsDir || SYSTEM.DEFAULT_SKILLS_DIR}/`;
    }

    // ★ Bootstrap: 静态分析项目符号和引用 → 填充 Semantic Memory
    this.bootstrapReport = bootstrapProject(config.project.projectPath);
    if (this.bootstrapReport) {
      for (const sym of this.bootstrapReport.symbols) {
        // ★ Map Bootstrap kind → SemanticNode type (interface → class)
        const nodeType = (
          sym.kind === 'interface' ? 'class' : sym.kind
        ) as 'function' | 'class' | 'module' | 'variable';
        this.semanticMemory.registerSymbol(
          sym.name,
          nodeType,
          sym.file_path,
          sym.location ?? undefined,
        );
      }
      for (const ref of this.bootstrapReport.references) {
        this.semanticMemory.registerReference(
          ref.from_name,
          ref.from_file,
          ref.to_name,
          ref.to_file ?? '',
          ref.ref_type,
        );
      }
    }

    // ★ Repo map 已从静态区移到 L7 动态区——每轮 run() 中生成带 PageRank 个性化的版本
    //   此处不再注入，改为每轮动态生成（见 prompt.setRepoMapPerTurn()）
  }

  // ==========================================================================
  // §2 run() — 主入口（AsyncGenerator）
  // ==========================================================================

  /**
   * ★ 主入口——执行用户输入
   *
   * @param userInput  用户输入的自然语言请求
   * @param mode       运行模式: plan(只读) | agent(逐步确认) | yolo(全自动)
   * @param sessionId  可选——恢复已有会话的 ID
   * @returns          事件流（AsyncGenerator，Agent 5 逐事件消费）
   */
  async *run(
    userInput: string,
    mode: RunMode,
    sessionId?: string,
  ): AsyncGenerator<AgentEvent, RunResult, void> {
    this.abortController = new AbortController();
    const startTime = Date.now();
    const globalTimeout = SYSTEM.GLOBAL_TIMEOUT_MS;

    // Step 0: 会话初始化 / 恢复
    const session = sessionId
      ? await this.resumeSession(sessionId)
      : this.createSession(userInput);
    // ★ 始终用实际用户输入覆盖——resumeSession 可能写入了占位文本
    session.currentInput = userInput;
    this.session = session;

    // ★ 启动 MCP Servers
    if (this.mcpClient) {
      try {
        const mcpCount = await this.mcpClient.startAll();
        if (mcpCount > 0) {
          yield {
            type: AGENT_EVENT.THINKING_DELTA,
            content: `[Comdr] ${mcpCount} MCP servers connected`,
          };
        }
      } catch (err) {
        yield {
          type: AGENT_EVENT.THINKING_DELTA,
          content: `[Comdr] MCP server connection failed: ${err instanceof Error ? err.message : String(err)}. Continuing without MCP.`,
        };
      }
      // ★ Emit initial MCP status
      yield {
        type: AGENT_EVENT.MCP_STATUS,
        servers: this.mcpClient.getStatuses(),
      };
    }

    // ★ Emit bootstrap done（如果有）
    if (this.bootstrapReport && this.bootstrapReport.files_scanned.length > 0) {
      yield {
        type: AGENT_EVENT.BOOTSTRAP_DONE,
        symbolsFound: this.bootstrapReport.symbols.length,
        referencesFound: this.bootstrapReport.references.length,
        filesScanned: this.bootstrapReport.files_scanned.length,
      };
    }

    // ★ Emit skills loaded（如果有）
    if (this.skillsLog) {
      yield {
        type: AGENT_EVENT.THINKING_DELTA,
        content: `[Comdr] ${this.skillsLog}`,
      };
      this.skillsLog = null; // 只输出一次
    }

    // ★ Emit session_started event
    yield {
      type: AGENT_EVENT.SESSION_STARTED,
      sessionId: session.id,
      mode,
    };

    // ★ 主循环
    while (session.turn < (this.config.agent?.maxTurns ?? SYSTEM.DEFAULT_MAX_TURNS)) {
      // 检查用户中断
      if (this.abortController.signal.aborted) {
        return yield* this.finalize(TERMINATION_REASON.USER_ABORTED, session);
      }

      // ★ Emit turn_begin event
      yield {
        type: AGENT_EVENT.TURN_BEGIN,
        turn: session.turn + 1,
        tokensUsed: session.tokensUsed,
      };

      // 1a. 全局超时检查
      if (globalTimeout > 0 && Date.now() - startTime > globalTimeout) {
        return yield* this.finalize(TERMINATION_REASON.TIMEOUT, session);
      }

      // 1b. Token 预算检查
      const maxTokens = this.config.agent?.tokenBudget ?? SYSTEM.DEFAULT_TOKEN_BUDGET;
      if (session.tokensUsed >= maxTokens) {
        return yield* this.finalize(TERMINATION_REASON.TOKEN_BUDGET_EXCEEDED, session);
      }

      try {
        // 1b. 上下文压缩（预检查）
        session.messages = await this.context.preCompact(session, maxTokens);

        // 1c. ★ reasoning_content 注入
        const injectedMessages = this.reasoning.inject(session.messages);
        // 修复历史缺失的 reasoning_content
        session.messages = this.reasoning.repairHistory(injectedMessages);

        // 1d. 获取工具列表——LLM 自己决定何时调用 skill 工具
        let tools = this.skillsLoader.activeTools();
        // ★ 合并 MCP 工具
        if (this.mcpClient) {
          tools = [...tools, ...this.mcpClient.getTools()];
        }
        // ★ 合并子智能体工具
        if (this.subAgentRegistry.size > 0) {
          tools = [...tools, ...this.subAgentRegistry.getAllTools()];
        }

        // ★ 1d-2. 子 Agent 防递归——移除 task_spawn，禁止 spawn 孙子 Agent
        if ((this as any).__isSubAgent) {
          tools = tools.filter((t) => t.name !== 'task_spawn');
        }

        // ★ 1d-3. 编译 Tool Blueprint——工具世界模型拓扑图
        this.allTools = tools;
        const blueprint = compileBlueprint(tools);
        this.blueprint = blueprint;
        this.prompt.setBlueprint(blueprint);

        let thinking = this.planner.defaultThinking();

        // 1e. ★ 每轮生成个性化 repo map（PageRank: chat files 100× boost, active files 50× boost）
        if (this.bootstrapReport) {
          const chatFiles = new Set<string>();
          const activeFiles = new Set<string>();
          for (const e of this.workingMemory.getStateWindow()) {
            if (e.key.startsWith('file:')) {
              const fp = e.key.slice(5);
              const credit = e.successCount * 2 - e.failCount * 3;
              if (credit >= 0) activeFiles.add(fp);
              if (e.successCount > 0 || e.failCount > 0) chatFiles.add(fp);
            }
          }
          const repoMap = generateRepoMap(this.bootstrapReport, { chatFiles, activeFiles });
          this.prompt.setRepoMapPerTurn(repoMap);
        }

        // 1f. 构建 prompt（★ 编排层不预取历史——LLM 需要时自己调 memory_recall）
        const anchor = anchorFromWindows(
          this.workingMemory.getStateWindow(),
          this.workingMemory.getIntentWindow(),
        );

        const promptMessages = this.prompt.build(session, tools, anchor);

        // ★ Tool Experience: 从最近工具调用中检索经验，追加到 prompt 末尾
        //   不影响前缀缓存——追加在 L7 之后
        const recentTools = session.messages
          .filter((m) => m.role === MESSAGE_ROLE.ASSISTANT && m.tool_calls)
          .slice(-2)
          .flatMap((m) => m.tool_calls?.map((tc) => tc.function.name) ?? []);
        const seenTools = new Set(recentTools);
        const hints: string[] = [];
        for (const toolName of seenTools) {
          const exps = this.toolExperience.retrieve(toolName, undefined, 1);
          for (const exp of exps) {
            hints.push(`[exp] ${exp.insight}`);
          }
        }
        if (hints.length > 0) {
          promptMessages.push({
            role: MESSAGE_ROLE.SYSTEM,
            content: hints.join('\n'),
          });
        }

        // ★ Self-Evolving Skills: 注入自动提炼的最佳实践
        const evolvedSkills = this.skillEvolution.getActiveSkills();
        if (evolvedSkills.length > 0) {
          const skillLines = evolvedSkills.map(
            (s) => `[evolved] ${s.description}`,
          );
          promptMessages.push({
            role: MESSAGE_ROLE.SYSTEM,
            content: skillLines.join('\n'),
          });
        }

        // ★ Cache monitoring: always use full tools for fingerprint stability
        const fp = this.prompt.computeStaticFingerprint(tools);
        const cacheStable = this.lastStaticFingerprint !== null
          && fp.fingerprint === this.lastStaticFingerprint;
        this.lastStaticFingerprint = fp.fingerprint;

        // 1f. 调用 LLM（★ 真流式——Promise-queue 桥接回调→AsyncGenerator）
        yield {
          type: AGENT_EVENT.THINKING_DELTA,
          content: `[turn ${session.turn + 1}] 思考中...`,
        };

        // ★ Promise-queue bridge: 将 onEvent 回调接入 AsyncGenerator yield
        let streamDone = false;
        let response!: Awaited<ReturnType<IDeepSeekClient['chatStream']>>;
        let streamError: unknown = null;
        const buffered: AgentEvent[] = [];
        let waiter: ((e: AgentEvent | null) => void) | null = null;
        function pushEvent(e: AgentEvent): void {
          if (waiter) { waiter(e); waiter = null; }
          else { buffered.push(e); }
        }
        function signalDone(): void {
          streamDone = true;
          if (waiter) { waiter(null); waiter = null; }
        }

        const chatPromise = this.llm.chatStream(
          {
            messages: promptMessages,
            tools,  // ★ Always send all tools — stable JSON = max prefix cache hit
            thinking,  // ★ 默认 high，停滞时 replan 升级到 max
            signal: this.abortController.signal,
          },
          (event) => {
            if (
              event.type === AGENT_EVENT.TEXT_DELTA ||
              event.type === AGENT_EVENT.THINKING_DELTA
            ) {
              pushEvent(event);
            }
          },
        );
        chatPromise.then(r => { response = r; signalDone(); })
          .catch(e => { streamError = e; signalDone(); });

        // ★ Real-time yield: 事件到达即推送给 Agent 5
        while (!streamDone || buffered.length > 0) {
          if (buffered.length > 0) {
            yield buffered.shift()!;
          } else if (!streamDone) {
            const event = await new Promise<AgentEvent | null>(
              resolve => {
                waiter = resolve;
                // ★ Defensive re-check: signalDone() 可能在 !streamDone 检查后、
                // Promise 创建前触发。此时 waiter 已设但 streamDone=true，
                // 直接 resolve(null) 避免永久挂起。
                if (streamDone) {
                  waiter = null;
                  resolve(null);
                }
              },
            );
            if (event) yield event;
          }
        }
        // Re-throw if chatStream failed
        if (streamError) throw streamError;

        // 累积 token 用量
        session.tokensUsed +=
          response.usage.promptTokens +
          response.usage.completionTokens;

        // ★ Emit actual token usage + cache metrics
        const hit = response.usage.cacheHitTokens;
        const miss = response.usage.cacheMissTokens;
        const totalCached = hit + miss;
        const cacheHitRate = totalCached > 0
          ? hit / totalCached
          : (cacheStable ? 1.0 : 0); // fallback: assume stable=cache hit
        yield {
          type: AGENT_EVENT.TOKEN_USAGE,
          usage: response.usage,
          cacheHitRate,
          cacheStable,
          fingerprint: fp.fingerprint,
        };

        // ★ Cache hit rate 告警
        if (cacheStable && cacheHitRate < 0.8) {
          this.logger?.log({
            type: AGENT_EVENT.PROGRESS_WARNING,
            stalledTurns: 0,
            message: `Prefix cache hit rate ${(cacheHitRate * 100).toFixed(1)}% < 80% — static zone may have drifted (fp: ${fp.fingerprint})`,
          });
        }

        // 日志
        this.logger?.logTokens(response.usage);

        // 1g. 保存 reasoning_content
        this.reasoning.capture(response.message);

        // 1h. 处理响应
        const message = response.message;

        const hasToolCalls =
          message.tool_calls != null && message.tool_calls.length > 0;

        if (message.content && !hasToolCalls) {
          // 纯文本响应 → 完成（文本已在上面流式输出）
          session.messages.push(message);
          return yield* this.finalize(TERMINATION_REASON.COMPLETED, session);
        }

        if (hasToolCalls) {
          session.messages.push(message);

          const toolResults: { call: ToolCall; result: ToolResult }[] = [];

                  // ★ 拓扑分层执行: 层内并行, 层间串行
          // hasToolCalls 已在上面保证 message.tool_calls 非空且 length > 0
          const toolCalls = message.tool_calls!;
          const schedule = scheduleParallel(toolCalls);

          for (const batch of schedule) {
            // ★ 需要确认的工具 → 先逐个 yield confirm event + await 用户响应
            //   用户拒绝的从 batch 中移除（不执行），批准的保留进并行批
            const permMode = this.config.agent?.permissionMode ?? 'confirm_destructive';
            const deniedCallIds = new Set<string>();
            for (const call of batch) {
              const toolDef = this.allTools.find((t) => t.name === call.function.name);
              if (toolDef?.permission === 'requires_approval' && permMode === 'confirm_destructive') {
                yield {
                  type: 'confirm_request',
                  callId: call.id,
                  toolName: call.function.name,
                  args: safeParseArgs(call.function.arguments),
                  reason: toolDef.description?.split('.')[0] ?? 'This tool may change files.',
                } satisfies AgentEvent;
                const approved = await new Promise<boolean>((r) => { this.pendingConfirms.set(call.id, r); });
                if (!approved) {
                  deniedCallIds.add(call.id);
                  const denyMsg: Message = {
                    role: MESSAGE_ROLE.TOOL,
                    content: `[denied] User rejected execution of ${call.function.name}.`,
                    tool_call_id: call.id,
                  };
                  session.messages.push(denyMsg);
                  yield {
                    type: AGENT_EVENT.TOOL_RESULT,
                    result: { callId: call.id, toolName: call.function.name, ok: false, content: denyMsg.content!, diffSummary: undefined, snapshotId: undefined, testFeedback: undefined, errorCategory: undefined },
                  } satisfies AgentEvent;
                }
              }
            }

            // ★ 并行执行——被拒的工具跳过
            const pendingEventsByIndex = new Map<number, AgentEvent[]>();
            let batchAborted = false;
            const batchResults = await Promise.all(
              batch.map(async (call, callIndex) => {
                if (deniedCallIds.has(call.id)) {
                  return { call, skip: true, result: { callId: call.id, toolName: call.function.name, ok: false, content: '[denied]', diffSummary: undefined, snapshotId: undefined, testFeedback: undefined, errorCategory: undefined } };
                }
                if (batchAborted) return { call, skip: true, abort: true, reason: TERMINATION_REASON.LOOP_DETECTED };
                if (batchAborted) return { call, skip: true, abort: true, reason: TERMINATION_REASON.LOOP_DETECTED };
                const events: AgentEvent[] = [];
                pendingEventsByIndex.set(callIndex, events);
                const preCheck = this.reflection.intra(call, session);
                if (preCheck.abort) {
                  events.push({
                    type: AGENT_EVENT.ERROR,
                    code: preCheck.abortReason ?? TERMINATION_REASON.LOOP_DETECTED,
                    message: preCheck.skipReason ?? 'Pre-execution check failed',
                    recoverable: false,
                  });
                  batchAborted = true;
                  return { call, skip: true, abort: true, reason: preCheck.abortReason };
                }
                if (preCheck.skip) {
                  const skipMsg: Message = {
                    role: MESSAGE_ROLE.TOOL,
                    content: `[skipped] ${preCheck.skipReason ?? 'irrelevant'}`,
                    tool_call_id: call.id,
                  };
                  session.messages.push(skipMsg);
                  return { call, skip: true, result: { callId: call.id, toolName: call.function.name, ok: false, content: skipMsg.content!, diffSummary: undefined, snapshotId: undefined, testFeedback: undefined, errorCategory: undefined } };
                }

                events.push({ type: AGENT_EVENT.TOOL_CALL, call });

                // ★ LSP: 对 file_edit/file_write 工具调用，做诊断差值检查
                const isFileEdit = call.function.name === 'file_edit' || call.function.name === 'file_write';
                let lspBefore: import('@comdr/core/types').DiagnosticSnapshot | null = null;
                if (this.lspBridge && isFileEdit) {
                  const args = safeParseArgs(call.function.arguments);
                  const filePath = typeof args.path === 'string' ? args.path : '';
                  if (filePath) {
                    lspBefore = await this.lspBridge.snapshotDiagnostics(filePath);
                  }
                }

                const rawResult = await this.executeToolAsync(call);
                const result: ToolResult = rawResult.diffSummary
                  ? { ...rawResult, diffSummary: summarizeDiff(rawResult.diffSummary) ?? rawResult.diffSummary }
                  : rawResult;
                events.push({ type: AGENT_EVENT.TOOL_RESULT, result });

                // ★ LSP: 执行后诊断快照 + 纠正决策
                if (this.lspBridge && isFileEdit && lspBefore) {
                  const args = safeParseArgs(call.function.arguments);
                  const filePath = typeof args.path === 'string' ? args.path : '';
                  if (filePath) {
                    const lspAfter = await this.lspBridge.snapshotDiagnostics(filePath);
                    const lspDecision = this.reflection.correctByLSP(lspBefore, lspAfter);
                    if (lspDecision.decision === 'rollback') {
                      // 纯恶化 → 回滚 + 注入反馈
                      if (result.snapshotId) this.tools?.rollback(result.snapshotId);
                      session.messages.push({
                        role: MESSAGE_ROLE.SYSTEM,
                        content: `[lsp-check] ${lspDecision.feedback} Changes rolled back.`,
                      });
                      return {
                        call,
                        skip: false,
                        result: {
                          callId: result.callId,
                          toolName: result.toolName,
                          ok: false,
                          content: `[lsp-check] ${result.toolName} changes rolled back due to LSP errors.`,
                          diffSummary: result.diffSummary,
                          snapshotId: result.snapshotId,
                          testFeedback: result.testFeedback,
                          errorCategory: result.errorCategory,
                        },
                      };
                    } else if (lspDecision.decision === 'retry') {
                      // 混合 → 注入反馈，让 Agent 再修
                      session.messages.push({
                        role: MESSAGE_ROLE.SYSTEM,
                        content: `[lsp-check] ${lspDecision.feedback}`,
                      });
                    }
                  }
                }

                session.messages.push({
                  role: MESSAGE_ROLE.TOOL,
                  content: result.content ?? (result.ok ? 'ok' : 'error'),
                  tool_call_id: call.id,
                });

                if (
                  result.testFeedback?.failed &&
                  result.testFeedback.failed > 0 &&
                  message.reasoning_content
                ) {
                  const correction = await this.reflection.selfCorrect(call, result, message.reasoning_content);
                  if (correction.corrected && correction.correctedArgs) {
                    const correctedCall: ToolCall = {
                      ...call,
                      function: { ...call.function, arguments: JSON.stringify(correction.correctedArgs) },
                    };
                    const correctedRaw = await this.executeToolAsync(correctedCall);
                    const correctedResult: ToolResult = correctedRaw.diffSummary
                      ? { ...correctedRaw, diffSummary: summarizeDiff(correctedRaw.diffSummary) ?? correctedRaw.diffSummary }
                      : correctedRaw;
                    events.push({ type: AGENT_EVENT.TOOL_RESULT, result: correctedResult });
                    session.messages.push({
                      role: MESSAGE_ROLE.TOOL,
                      content: correctedResult.content ?? 'ok',
                      tool_call_id: correctedCall.id,
                    });
                    if (result.snapshotId) this.tools?.rollback(result.snapshotId);
                    return { call: correctedCall, result: correctedResult };
                  }
                }
                return { call, result };
              })
            );

            // ★ Yield all pending events in batch order (by call index, deterministic)
            for (let i = 0; i < batch.length; i++) {
              const evs = pendingEventsByIndex.get(i);
              if (evs) for (const ev of evs) yield ev;
            }

            for (const r of batchResults) {
              // ★ skip: false 时保证 result 存在：（1）正常执行 → result 来自 executeToolAsync；（2）LSP rollback → result 显式构造
              if (!r.skip) toolResults.push({ call: r.call, result: r.result! });
              if (r.abort) {
                return yield* this.finalize(r.reason ?? TERMINATION_REASON.LOOP_DETECTED, session);
              }
            }
          }

          // Post-loop: 更新内存 (按原始顺序)
          for (const { call, result } of toolResults) {
            // L3 — LLM 语义审查（★ await 确保 feedback 注入在当前轮次内）
            try {
              const postCheck = await this.reflection.inter(call, result, session);
              if (postCheck.feedback) {
                session.messages.push({
                  role: MESSAGE_ROLE.SYSTEM,
                  content: `[reflection] ${postCheck.feedback}`,
                });
              }
            } catch {
              // reflection 调用失败 → 静默降级，不阻塞主流程
              console.warn('[loop] reflection.inter() call failed, silently degrading');
            }

            // ★ L2 — 自检管线（确定性规则，不调 LLM）
            // ★ write/edit 后清除文件缓存 + 增量更新 embedding 索引
            if (call.function.name === 'file_write' || call.function.name === 'file_edit') {
              const sargs = safeParseArgs(call.function.arguments);
              const targetPath = typeof sargs.path === 'string' ? sargs.path : '';
              if (targetPath) {
                this.fileCache.delete(targetPath);
              }
            }
            const checkCtx = this.buildCheckContext();
            for (const rule of this.checkRules) {
              if (!rule.assess(call)) continue;
              const issue = rule.check(call, result, checkCtx);
              if (issue) {
                // 去重：同文件同规则同偏离不重复
                const args = safeParseArgs(call.function.arguments);
                const targetPath = typeof args.path === 'string' ? args.path : '';
                const dupKey = targetPath
                  ? `${rule.id}:${targetPath}:${issue.message}`
                  : `${rule.id}:${issue.message}`;
                if (this.emittedIssues.has(dupKey)) continue;
                // ★ 上限保护：超过 200 条清空旧记录
                if (this.emittedIssues.size > 200) {
                  this.emittedIssues.clear();
                }
                this.emittedIssues.add(dupKey);

                // ★ 格式化：不使用 emoji（终端兼容性），截断时补 '...'
                const hintSuffix = issue.hint ? ` | ${issue.hint}` : '';
                let msg = `[self-check] ${issue.message}${hintSuffix}`;
                if (msg.length > SYSTEM.SELF_CHECK_MAX_MESSAGE_LENGTH) {
                  const cut = SYSTEM.SELF_CHECK_MAX_MESSAGE_LENGTH - 4;
                  // ★ Array.from 保证不切在 surrogate pair 中间（emoji 等）
                  msg = [...msg].slice(0, Math.max(0, cut)).join('') + '...';
                }
                session.messages.push({
                  role: MESSAGE_ROLE.SYSTEM,
                  content: msg,
                });
              }
            }

            // ★ 跟踪 session 内新文件——补充 bootstrap 文件列表
            if (call.function.name === 'file_write') {
              const args = safeParseArgs(call.function.arguments);
              if (typeof args.path === 'string') this.sessionFiles.add(args.path);
            }

            // ★ Tool Experience: 记录每次工具调用的成败经验
            {
              const sargs = safeParseArgs(call.function.arguments);
              const file = typeof sargs.path === 'string' ? sargs.path : undefined;
              this.toolExperience.record(
                call.function.name,
                file,
                result.ok,
                result.errorCategory ?? undefined,
                session.turn,
              );

              // ★ Self-Evolving Skills: 喂入经验，尝试提炼新 skill
              const allExps = this.toolExperience.getAll();
              this.skillEvolution.feed(allExps);
            }

            this.workingMemory.updateStateWindow(result, call, session.turn);
            // ★ 反馈闭环: 搜索词关联到文件
            if (call.function.name === 'file_grep' || call.function.name === 'file_search') {
              const sargs = safeParseArgs(call.function.arguments);
              const query = typeof sargs.query === 'string' ? sargs.query : '';
              const path = typeof sargs.path === 'string' ? sargs.path : undefined;
              if (query) this.workingMemory.recordSearch(query, path);
            }
            this.semanticMemory.recordFileOperation(call, result, session.turn);
          }

          // 1i. Progress check
          const signal = this.progress.measure(session.turn, toolResults);

          // ★ 累加 reflection 反思调用的 token 消耗
          session.tokensUsed += this.reflection.getTokensSpentThisTurn();
          const stall = this.progress.isStalled();

          if (stall.level === 'abort') {
            yield {
              type: AGENT_EVENT.PROGRESS_WARNING,
              message: `连续 ${signal.stallCount} 轮零进展。检测到停滞，终止执行。`,
              stalledTurns: signal.stallCount,
            };
            return yield* this.finalize(TERMINATION_REASON.STALL_DETECTED, session);
          }

          if (stall.level === 'warning') {
            yield {
              type: AGENT_EVENT.PROGRESS_WARNING,
              message: `连续 ${signal.stallCount} 轮零进展。请尝试不同的方法。`,
              stalledTurns: signal.stallCount,
            };

            // 注入反思提示
            session.messages.push({
              role: MESSAGE_ROLE.SYSTEM,
              content:
                `[progress_warning] You have made no progress for ${signal.stallCount} turns. ` +
                'Consider a different approach or ask for clarification.',
            });
          }

          // ★ 停滞升级 → 覆盖下一轮的 thinking 配置
          const newThinking = this.planner.replan(thinking, signal);
          if (newThinking) {
            thinking = newThinking;
            yield {
              type: AGENT_EVENT.THINKING_DELTA,
              content: `思维模式升级: 思考:${newThinking.type === 'enabled' ? newThinking.effort : '标准'}`,
            };
          }
        } else {
          // ★ Fallback: 空响应 或 空 tool_calls——finalize 防止无限循环
          // DeepSeek V4 thinking 模式下可能只返回 reasoning_content。
          session.messages.push(message);
          return yield* this.finalize(TERMINATION_REASON.COMPLETED, session);
        }
      } catch (err) {
        // API 认证错误 → 不可恢复
        if (err instanceof DeepSeekAuthError) {
          yield {
            type: AGENT_EVENT.ERROR,
            code: TERMINATION_REASON.API_ERROR_UNRECOVERABLE,
            message: `API 认证失败: ${err.message}`,
            recoverable: false,
          };
          return yield* this.finalize(TERMINATION_REASON.API_ERROR_UNRECOVERABLE, session);
        }

        // API 重试耗尽 → 不可恢复
        if (err instanceof DeepSeekRetryError) {
          yield {
            type: AGENT_EVENT.ERROR,
            code: TERMINATION_REASON.API_ERROR_UNRECOVERABLE,
            message: `API 重试耗尽 (${err.attempts} 次): ${err.message}`,
            recoverable: false,
          };
          return yield* this.finalize(TERMINATION_REASON.API_ERROR_UNRECOVERABLE, session);
        }

        // AbortError → 用户中断
        // ★ Node.js AbortController 可接受任意 reason 类型，
        //   不能只匹配 DOMException。同时检查 name 属性和 instanceof。
        if (
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return yield* this.finalize(TERMINATION_REASON.USER_ABORTED, session);
        }

        // 400 错误 → tool_calls/tool_results 不匹配，无法恢复
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (errorMsg.includes('400') || errorMsg.includes('tool_calls')) {
          yield {
            type: AGENT_EVENT.ERROR,
            code: TERMINATION_REASON.API_ERROR_UNRECOVERABLE,
            message: `API 消息结构错误（不可恢复）: ${errorMsg}`,
            recoverable: false,
          };
          return yield* this.finalize(TERMINATION_REASON.API_ERROR_UNRECOVERABLE, session);
        }

        // 其他错误 → 注入反馈，尝试恢复
        yield {
          type: AGENT_EVENT.ERROR,
          code: ERROR_CATEGORY.EXECUTION_ERROR,
          message: errorMsg,
          recoverable: true,
        };

        // ★ 清除本轮 token 计数器，避免跨轮重复计数
        this.reflection.getTokensSpentThisTurn();
        this.context.getTokensSpentThisTurn();

        session.messages.push({
          role: MESSAGE_ROLE.SYSTEM,
          content: `[error] ${errorMsg}. Try a different approach.`,
        });
      }

      // 1j. 上下文压缩（后检查）
      session.messages = await this.context.preCompact(session, maxTokens);

      // ★ 累加上下文压缩调用的 token 消耗
      session.tokensUsed += this.context.getTokensSpentThisTurn();

      // ★ 轮末预算检查——捕获轮内超支，不等到下轮才发现
      if (session.tokensUsed >= maxTokens) {
        return yield* this.finalize(TERMINATION_REASON.TOKEN_BUDGET_EXCEEDED, session);
      }

      // ★ 压缩后 reasoning_content 保护
      session.messages = this.reasoning.preserveAfterCompact(session.messages);

      session.turn++;

      // ★ 中间情景快照（每 N 轮，支持崩溃恢复 + 跨会话检索）
      if (
        SYSTEM.EPISODIC_SNAPSHOT_INTERVAL > 0 &&
        session.turn % SYSTEM.EPISODIC_SNAPSHOT_INTERVAL === 0
      ) {
        this.episodicMemory.consolidate(
          session,
          this.context.getPersistentSummary(),
        );
      }

      // ★ 每轮结束自动保存（崩溃恢复用）
      this.sessionStore.save(session);
    }

    return yield* this.finalize(TERMINATION_REASON.MAX_TURNS, session);
  }

  // ==========================================================================
  // §3 getSession() — 获取当前会话
  // ==========================================================================

  /**
   * 获取当前会话完整状态
   */
  getSession(): SessionState {
    if (!this.session) {
      return this.createSession('');
    }
    // 同步双窗口到 session
    this.session.stateWindow = this.workingMemory.getStateWindow();
    this.session.intentWindow = this.workingMemory.getIntentWindow();
    return this.session;
  }

  // ==========================================================================
  // §4 resumeSession() — 恢复会话
  // ==========================================================================

  /**
   * 恢复已有会话
   * 恢复 messages + state window + intent window + tempId 映射
   */
  async resumeSession(sessionId: string): Promise<SessionState> {
    // ★ 从持久化存储恢复
    const saved = this.sessionStore.load(sessionId);
    if (saved) {
      // 恢复子系统状态
      this.workingMemory.restore(saved.stateWindow, saved.intentWindow);
      this.reasoning.clear(); // reasoning cache 不能跨会话
      this.progress.reset();
      this.reflection.reset();
      this.emittedIssues.clear();
      this.fileCache.clear();
      this.sessionFiles.clear();

      saved.currentInput = '(resumed session)';
      saved.outcome = null;
      saved.turn = saved.turn; // 保持原轮次

      this.session = saved;
      return saved;
    }

    // 未找到 → 创建新会话
    const session = this.createSession('(resumed)');
    session.id = sessionId;
    this.session = session;
    return session;
  }

  // ==========================================================================
  // §5 abort() — 中断
  // ==========================================================================

  /**
   * 中断当前执行
   */
  abort(): void {
    this.abortController?.abort();
    // ★ abort 时拒绝所有待确认的工具调用
    for (const [callId, resolve] of this.pendingConfirms) {
      resolve(false);
      this.pendingConfirms.delete(callId);
    }
  }

  /**
   * ★ 工具确认回调——用户在 UI 上点击 Approve/Deny 后调用。
   *
   * @param callId   工具调用 ID（来自 AgentEventConfirmRequest）
   * @param approved true=批准执行，false=拒绝
   */
  confirm(callId: string, approved: boolean): void {
    const resolve = this.pendingConfirms.get(callId);
    if (resolve) {
      this.pendingConfirms.delete(callId);
      resolve(approved);
    }
  }

  /**
   * 获取 MCP Server 连接状态（供 Agent 5 展示）
   */
  getMCPServers(): MCPServerStatus[] {
    return this.mcpClient?.getStatuses() ?? [];
  }

  /**
   * ★ 销毁引擎——关闭 MCP 连接，清理资源
   */
  async destroy(): Promise<void> {
    if (this.mcpClient) {
      await this.mcpClient.shutdown();
    }
  }

  /**
   * ★ 设置 LSP 桥接——由 VS Code Extension (Terminal 2) 调用。
   * CLI 模式下为 null → LSP 相关功能静默降级。
   */
  setLSPBridge(bridge: ILSPBridge | null): void {
    this.lspBridge = bridge;
  }

  /**
   * ★ 注册子智能体。外部（VS Code / CLI）在 Engine 启动后调用。
   *   子智能体工具会以 `prefix__toolName` 格式暴露给 LLM。
   */
  registerSubAgent(agent: import('@comdr/core/contracts').ISubAgent): void {
    this.subAgentRegistry.register(agent);
  }

  /**
   * ★ 供子 Agent 调用的工具执行入口。
   *   子 Agent 用此方法走主引擎原生工具通路（repo-map 感知、Git 感知、ripgrep 等），
   *   而非山寨 fs 实现。
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.executeToolAsync({
      id: `sub-${Date.now().toString(36)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  /**
   * ★ 派生独立 Engine 实例，共享 LLM + tools + config + logger + contextLLM。
   * 用于子 Agent 创建——每个子 Agent 有独立的 session/working memory/progress，
   * 但调用的是同一底层 LLM 客户端和工具执行器。
   *
   * 替代 subagent.ts 中的 `(engine as any)` 反模式。
   */
  /**
   * ★ 派生子 Engine 实例——用于 task_spawn 上下文隔离。
   *
   * 隔离策略（late-cli 2026）:
   *   - 独立 session / working memory / progress
   *   - 共享 LLM client / tools / config（但移除 task_spawn 防递归）
   *   - 子 Agent session 不持久化——执行完即销毁
   */
  forkEngine(): Engine {
    const sub = new Engine(this.llm, this.config, this.tools, this.logger, this.contextLLM);
    // ★ 继承子智能体注册表（但不继承 task_spawn——防递归 spawn）
    this.subAgentRegistry.copyTo(sub['subAgentRegistry']);
    // ★ 标记为子 Engine——prompt builder 会跳过全量上下文，只给任务描述
    (sub as any).__isSubAgent = true;
    return sub;
  }

  // ==========================================================================
  // §6 内部方法
  // ==========================================================================

  /**
   * ★ 终止辅助生成器——先 yield DONE 事件，再返回 RunResult
   *
   * 使用方式: return yield* this.finalize(TERMINATION_REASON.COMPLETED, session);
   * yield* 委托到同步生成器 → 先 yield AgentEventDone → 再 return RunResult
   */
  private *finalize(
    reason: TerminationReason,
    session: SessionState,
  ): Generator<AgentEvent, RunResult> {
    const result = this.terminate(reason, session);
    yield {
      type: AGENT_EVENT.DONE,
      result,
    };
    return result;
  }

  /**
   * 创建新会话
   */
  private createSession(userInput: string): SessionState {
    const now = new Date().toISOString();
    const session: SessionState = {
      id: `comdr-${Date.now().toString(36)}`,
      turn: 0,
      tokensUsed: 0,
      currentInput: userInput,
      outcome: null,
      messages: [],
      stateWindow: [],
      intentWindow: [],
      tempIdMappings: {},
      createdAt: now,
      updatedAt: now,
    };

    // 重置所有子系统
    this.reasoning.clear();
    this.workingMemory.clear();
    this.progress.reset();
    this.reflection.reset();
    this.context.reset();
    this.skillsLoader.reset();
    this.emittedIssues.clear();
    this.fileCache.clear();
    this.sessionFiles.clear();

    return session;
  }

  /**
   * 终止执行
   */
  private terminate(
    reason: TerminationReason,
    session: SessionState,
  ): RunResult {
    // 标记 outcome
    session.outcome = reason;
    session.updatedAt = new Date().toISOString();

    const ok =
      reason === TERMINATION_REASON.COMPLETED;

    const summary = TERMINATION_SUMMARIES[reason] ?? `Terminated: ${reason}`;

    // 生成情景摘要 + 持久化到磁盘
    if (session.turn > 0) {
      const structuredSummary = this.context.getPersistentSummary();
      this.episodicMemory.consolidate(session, structuredSummary);
      this.episodicMemory.commit();
      this.sessionStore.saveEpisodic(this.episodicMemory.serialize());

      this.sessionStore.saveSemantic(this.semanticMemory.serialize());
    }

    // ★ 持久化保存
    this.sessionStore.save(session);

    return {
      ok,
      turns: session.turn,
      tokensUsed: session.tokensUsed,
      summary,
      sessionId: session.id,
    };
  }

  /**
   * ★ 统一工具输出格式——与 Rust 层 ToolOutput::ok/err 对齐。
   * [OK] tool_name k=v k=v  /  [ERR] tool_name key=val error=msg
   */
  private formatToolOutput(toolName: string, ok: boolean, pairs: Record<string, string>, detail?: string): string {
    const parts: string[] = [ok ? `[OK] ${toolName}` : `[ERR] ${toolName}`];
    for (const [k, v] of Object.entries(pairs)) {
      parts.push(`${k}=${v}`);
    }
    if (detail) {
      parts.push(`\n${detail}`);
    }
    return parts.join(' ');
  }

  /**
   * ★ 构建 TS 层工具执行上下文。
   */
  private getToolExecContext(): ToolExecContext {
    return {
      projectPath: this.config.project.projectPath,
      episodicMemory: this.episodicMemory,
      semanticMemory: this.semanticMemory,
      nativeTools: this.tools,
      engine: this,
      blueprint: this.blueprint ?? undefined,
      allTools: this.allTools,
    };
  }

  /**
   * ★ 构建自检管线上下文。
   */
  private buildCheckContext(): CheckContext {
    // ★ 合并 bootstrap 文件 + session 内新文件
    const allFiles = [
      ...(this.bootstrapReport?.files_scanned ?? []),
      ...this.sessionFiles,
    ];
    return {
      projectPath: this.config.project.projectPath,
      allFiles,
      fileCache: this.fileCache,
    };
  }

  /**
   * 执行工具（Agent 3 SDB 桥接或 mock）
   */
  private async executeToolAsync(call: ToolCall): Promise<ToolResult> {
    // ★ 子智能体工具 → 路由到 SubAgentRegistry
    if (this.subAgentRegistry.resolve(call.function.name)) {
      const args = safeParseArgs(call.function.arguments);
      return this.subAgentRegistry.executeTool(call.function.name, args);
    }

    // ★ 高级 TS 工具 → 本地执行
    if (isAdvancedTool(call.function.name)) {
      return await executeAdvancedTool(call, this.getToolExecContext());
    }

    // ★ MCP 工具 → 路由到 MCP Client
    if (call.function.name.startsWith('mcp__') && this.mcpClient) {
      return this.executeMCPTool(call);
    }

    if (!this.tools) {
      // Agent 3 未就绪 → mock 实现
      return this.mockExecuteTool(call);
    }

    const args = safeParseArgs(call.function.arguments);

    // 从工具注册表查找超时和权限
    const toolDef = this.skillsLoader
      .activeTools()
      .find((t) => t.name === call.function.name);

    const opts: ToolExecuteOptions = {
      name: call.function.name,
      callId: call.id,
      arguments: args,
      projectPath: this.config.project.projectPath,
      timeoutMs: toolDef?.timeoutMs ?? SYSTEM.DEFAULT_TOOL_TIMEOUT_MS,
    };

    try {
      // ★ execute() 直接返回 ToolResult（已含 callId + toolName + testFeedback）
      const result = this.tools.execute(opts);

      // ★ SDB Step 6 Self-Correct: test_failed → DeepSeek side channel 自动修复
      if (
        result.testFeedback &&
        result.testFeedback.failed > 0 &&
        result.snapshotId
      ) {
        // 从 reasoning cache 取原始推理链
        const reasoningContent = this.reasoning.getReasoning(call.id);

        const correction = await this.reflection.selfCorrect(
          call,
          result,
          reasoningContent,
        );

        if (correction.corrected && correction.correctedArgs) {
          // ★ 用修正后的参数重新执行 file_edit
          const correctedOpts: ToolExecuteOptions = {
            ...opts,
            arguments: correction.correctedArgs,
          };
          const retryResult = this.tools.execute(correctedOpts);

          // 如果重试后测试通过，返回修正后的结果
          if (
            retryResult.ok &&
            (!retryResult.testFeedback || retryResult.testFeedback.failed === 0)
          ) {
            // 清理原始快照——修正已成功，不需要保留之前的文件状态
            if (this.tools && result.snapshotId) {
              this.tools.discardSnapshot(result.snapshotId);
            }
            return {
              ...retryResult,
              callId: call.id,
              toolName: call.function.name,
              diffSummary: retryResult.diffSummary ??
                `[self-corrected] ${correction.explanation ?? 'auto-fixed'}`,
            };
          }
        }

        // Self-correct 失败 → 回滚到快照
        if (this.tools) {
          this.tools.rollback(result.snapshotId);
        }
        return {
          ...result,
          ok: false,
          content: `Test failed (${result.testFeedback.failed} of ${result.testFeedback.passed + result.testFeedback.failed})` +
            (correction.explanation ? `. Self-correct attempted: ${correction.explanation}` : '. Self-correct could not fix.') +
            '. Changes rolled back.',
          errorCategory: 'test_failed',
        };
      }

      return result;
    } catch (err) {
      return {
        callId: call.id,
        toolName: call.function.name,
        ok: false,
        content: String(err),
        errorCategory: 'execution_error',
      };
    }
  }

  /**
   * ★ MCP 工具执行
   */
  private async executeMCPTool(call: ToolCall): Promise<ToolResult> {
    // ★ 防御性 guard：调用方已检查 this.mcpClient 存在，但方法本身也做检查
    if (!this.mcpClient) {
      return {
        callId: call.id, toolName: call.function.name, ok: false,
        content: 'MCP client not available', errorCategory: 'execution_error',
      };
    }
    const args = safeParseArgs(call.function.arguments);

    try {
      const result = await this.mcpClient.callTool(
        call.function.name,
        args,
      );

      const name = call.function.name;
      const content = result.ok
        ? this.formatToolOutput(name, true, {}, result.content ?? undefined)
        : this.formatToolOutput(name, false, { error: result.errorCategory ?? 'execution_error' }, result.content ?? undefined);
      return {
        callId: call.id,
        toolName: name,
        ok: result.ok,
        content,
        errorCategory: result.ok
          ? undefined
          : (result.errorCategory as ToolResult['errorCategory'] ?? 'execution_error'),
      };
    } catch (err) {
      const name = call.function.name;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        callId: call.id,
        toolName: name,
        ok: false,
        content: this.formatToolOutput(name, false, { error: 'execution_error' }, msg),
        errorCategory: 'execution_error',
      };
    }
  }

  /**
   * Mock 工具执行（Agent 3 未就绪时的降级方案）
   */
  private mockExecuteTool(call: ToolCall): ToolResult {
    const name = call.function.name;
    return {
      callId: call.id,
      toolName: name,
      ok: false,
      content: this.formatToolOutput(name, false, { error: 'execution_error' }, 'Agent 3 not available. Run `pnpm build:tools`.'),
      errorCategory: 'execution_error',
    };
  }

}

// ============================================================================
// §7 终止原因摘要
// ============================================================================

const TERMINATION_SUMMARIES: Record<TerminationReason, string> = {
  [TERMINATION_REASON.COMPLETED]: '任务执行完毕',
  [TERMINATION_REASON.MAX_TURNS]: '达到最大执行轮次',
  [TERMINATION_REASON.TOKEN_BUDGET_EXCEEDED]: 'Token 超出预算',
  [TERMINATION_REASON.STALL_DETECTED]: '检测到执行停滞',
  [TERMINATION_REASON.LOOP_DETECTED]: '检测到重复循环',
  [TERMINATION_REASON.SCOPE_DRIFT]: '检测到范围漂移',
  [TERMINATION_REASON.USER_ABORTED]: '用户中断',
  [TERMINATION_REASON.TOOL_ERROR_UNRECOVERABLE]: '工具执行不可恢复错误',
  [TERMINATION_REASON.API_ERROR_UNRECOVERABLE]: 'API 不可恢复错误',
  [TERMINATION_REASON.TIMEOUT]: '全局执行超时',
};

// ============================================================================
// §8 工厂函数
// ============================================================================

/**
 * 创建 Engine 实例
 *
 * @param llm     DeepSeek 客户端（来自 @comdr/llm）
 * @param config  完整配置（来自 @comdr/core loadConfig）
 * @param tools   可选——原生工具执行器（Agent 3 未就绪时传 null）
 * @param logger  可选——事件日志
 */
export function createEngine(
  llm: IDeepSeekClient,
  config: AgentConfig,
  tools: INativeTools | null = null,
  logger: IEventLogger | null = null,
  contextLLM?: IDeepSeekClient,
): Engine {
  return new Engine(llm, config, tools, logger, contextLLM);
}
