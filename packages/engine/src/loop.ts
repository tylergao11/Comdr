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
} from '@comdr/core/contracts';
import { DeepSeekAuthError, DeepSeekRetryError } from '@comdr/core/contracts';

import { ReasoningManager } from './reasoning.js';
import { PromptConstructor, anchorFromWindows } from './prompt.js';
import { ContextManager } from './context.js';
import { WorkingMemory } from './memory/working.js';
import { EpisodicMemory } from './memory/episodic.js';
import { SemanticMemory } from './memory/semantic.js';
import { TaskPlanner } from './planner.js';
import { ReflectionEngine } from './reflection.js';
import { ProgressMeter } from './progress.js';
import { SkillsLoader } from './skills.js';
import { SessionStore } from './persistence.js';
import { MCPClient } from './mcp-client.js';
import { safeParseArgs } from './utils.js';
import { summarizeDiff } from './smart-truncate.js';
import { discoverComdrMd, discoverAndRetrieve } from './world-model.js';
import { createToolRetriever } from './tool-retriever.js';
import { generateRepoMap } from './repo-map.js';
import { isAdvancedTool, executeAdvancedTool } from './tools/execute.js';
import type { ToolExecContext } from './tools/execute.js';
import { scheduleParallel } from './scheduler.js';
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
  private readonly planner: TaskPlanner;
  private readonly reflection: ReflectionEngine;
  private readonly progress: ProgressMeter;
  private readonly skillsLoader: SkillsLoader;
  private readonly sessionStore: SessionStore;
  private readonly mcpClient: MCPClient | null;

  // 运行时状态
  private session: SessionState | null = null;
  private abortController: AbortController | null = null;
  /** ★ 上一轮的静态区指纹——用于检测前缀缓存是否失效 */
  private lastStaticFingerprint: string | null = null;
  /** Skills 加载日志，在 run() 启动时 yield */
  private skillsLog: string | null = null;
  /** ★ Bootstrap 结果——构造时完成，run() 时 yield 事件 */
  private bootstrapReport: BootstrapReport | null = null;

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
    this.planner = new TaskPlanner();
    this.reflection = new ReflectionEngine(llm);
    this.progress = new ProgressMeter();
    this.skillsLoader = new SkillsLoader();
    this.sessionStore = new SessionStore(config.project.projectPath);

    // ★ 从磁盘恢复跨会话记忆（不存在/损坏 → 静默降级）
    const epData = this.sessionStore.loadEpisodic();
    if (epData) this.episodicMemory.deserialize(epData.episodes, epData.reflections);
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

    // ★ 扫描 skills 目录，注册所有 SKILL.md（渐进式加载）
    const skillsDir = pathResolve(
      config.project.projectPath,
      config.project.skillsDir || SYSTEM.DEFAULT_SKILLS_DIR,
    );
    const skillsCount = this.skillsLoader.scanDirectory(skillsDir);
    if (skillsCount > 0) {
      this.skillsLog = `Loaded ${skillsCount} skills from ${config.project.skillsDir || SYSTEM.DEFAULT_SKILLS_DIR}/`;
    }

    // ★ 初始化 TF-IDF 工具检索器——按语义匹配工具，替代固定白名单
    const allToolDefs = this.skillsLoader.activeTools();
    if (allToolDefs.length > 0) {
      this.planner.setRetriever(createToolRetriever(allToolDefs));
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

    // ★ Repository Map: Aider-style 仓库拓扑视图（L1.5，同会话静态 → 缓存友好）
    const repoMap = generateRepoMap(this.bootstrapReport);
    if (repoMap) this.prompt.setRepoMap(repoMap);
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
          // ★ 将 MCP 工具纳入 BM25 检索索引
          this.planner.addToolsToRetriever(this.mcpClient.getTools());
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

    // ★ World Model 分块检索（同会话不变 → L1.x 静态区缓存友好）
    const worldModel = discoverAndRetrieve(
      userInput,
      this.config.project.projectPath,
      this.config.project.comdrMdPath || 'COMDR.md',
    );
    if (worldModel.relevantChunks.length > 0) {
      const chunksText = worldModel.relevantChunks
        .map((c) => c.content)
        .join('\n\n---\n\n');
      this.prompt.setWorldModelContext(chunksText);
      if (worldModel.didChunk) {
        yield {
          type: AGENT_EVENT.THINKING_DELTA,
          content: `[Comdr] World model: ${worldModel.relevantChunks.length} relevant sections loaded`,
        };
      }
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

        // 1d. 任务路由（★ 先匹配 trigger 自动展开 skill，再获取工具列表）
        const triggeredSkills = this.skillsLoader.matchTriggers(
          session.currentInput,
        );
        if (triggeredSkills.length > 0) {
          yield {
            type: AGENT_EVENT.THINKING_DELTA,
            content: `[Comdr] 自动激活 skill: ${triggeredSkills.join(', ')}`,
          };
        }
        let tools = this.skillsLoader.activeTools();
        // ★ 合并 MCP 工具
        if (this.mcpClient) {
          tools = [...tools, ...this.mcpClient.getTools()];
        }
        let route = this.planner.route(session.currentInput, tools);

        // ★ 行为指令注入静态区——同 route 不变 = 缓存友好
        this.prompt.setTaskBehavior(route);

        // ★ L4.5 — KARMA-style State-Enriched Graph RAG
        //   用 State Window 的活跃文件路径作为精确检索种子
        const statePaths = session.stateWindow.map(e => e.key); // 纯文件路径
        const enrichedQuery = statePaths.length > 0
          ? `${session.currentInput} ${statePaths.join(' ')}`
          : session.currentInput;
        const entityContext = this.semanticMemory.retrieveRelevantEntities(enrichedQuery);
        this.prompt.setEntityContext(entityContext);

        // ★ L4.5 — Context Anchor 压缩摘要（每轮更新）
        const summaryText = this.context.getSummaryText();
        this.prompt.setCompactSummary(summaryText);

        // 1e. 构建 prompt（★ 每次构建时检索跨会话相关历史）
        const relatedHistory = this.episodicMemory
          .retrieve(session.currentInput)
          .map((ep) => ep.structuredSummary?.sessionIntent ?? ep.task)
          .filter(Boolean);
        const reflections = this.episodicMemory.getReflections().map((r) => r.insight);
        const anchor = anchorFromWindows(
          this.workingMemory.getStateWindow(),
          this.workingMemory.getIntentWindow(),
          relatedHistory,
          reflections.length > 0 ? reflections : undefined,
        );
        const promptMessages = this.prompt.build(session, tools, route, anchor);

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
            thinking: route.thinking,
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
              resolve => { waiter = resolve; },
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
          const schedule = scheduleParallel(message.tool_calls!);

          for (const batch of schedule) {
            // ★ 收集并行执行中的事件（yield 不能在 Promise.all 内）
            const pendingEvents: AgentEvent[] = [];
            const batchResults = await Promise.all(
              batch.map(async (call) => {
                const preCheck = this.reflection.intra(call, session, route);
                if (preCheck.abort) {
                  pendingEvents.push({
                    type: AGENT_EVENT.ERROR,
                    code: preCheck.abortReason ?? TERMINATION_REASON.LOOP_DETECTED,
                    message: preCheck.skipReason ?? 'Pre-execution check failed',
                    recoverable: false,
                  });
                  return { call, skip: true, abort: true, reason: preCheck.abortReason };
                }
                if (preCheck.skip) {
                  const skipMsg: Message = {
                    role: MESSAGE_ROLE.TOOL,
                    content: `[skipped] ${preCheck.skipReason ?? 'irrelevant'}`,
                    tool_call_id: call.id,
                  };
                  session.messages.push(skipMsg);
                  return { call, skip: true, result: { callId: call.id, toolName: call.function.name, ok: false, content: skipMsg.content! } as ToolResult };
                }

                pendingEvents.push({ type: AGENT_EVENT.TOOL_CALL, call });

                const rawResult = await this.executeToolAsync(call);
                const result: ToolResult = rawResult.diffSummary
                  ? { ...rawResult, diffSummary: summarizeDiff(rawResult.diffSummary) ?? rawResult.diffSummary }
                  : rawResult;
                pendingEvents.push({ type: AGENT_EVENT.TOOL_RESULT, result });

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
                    pendingEvents.push({ type: AGENT_EVENT.TOOL_RESULT, result: correctedResult });
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

            // ★ Yield all pending events in batch order
            for (const ev of pendingEvents) yield ev;

            for (const r of batchResults) {
              if (!r.skip) toolResults.push({ call: r.call, result: r.result! });
              if (r.abort) {
                return yield* this.finalize(r.reason ?? TERMINATION_REASON.LOOP_DETECTED, session);
              }
            }
          }

          // Post-loop: 更新内存 (按原始顺序)
          for (const { call, result } of toolResults) {
            this.reflection.inter(call, result, session).then(postCheck => {
              if (postCheck.feedback) {
                session.messages.push({
                  role: MESSAGE_ROLE.SYSTEM,
                  content: `[reflection] ${postCheck.feedback}`,
                });
              }
            });
            this.workingMemory.updateStateWindow(result, call, session.turn);
            this.workingMemory.updateIntentWindow(call, result, session);
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

          // ★ 动态重规划 → 覆盖下一轮的路由
          const newRoute = this.planner.replan(route, signal);
          if (newRoute) {
            route = newRoute;
            yield {
              type: AGENT_EVENT.THINKING_DELTA,
              content: `思维模式升级: ${newRoute.thinking.type === THINKING_TYPE.ENABLED ? `思考:${newRoute.thinking.effort}` : '标准'}`,
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
        if (err instanceof DOMException && err.name === 'AbortError') {
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

        session.messages.push({
          role: MESSAGE_ROLE.SYSTEM,
          content: `[error] ${errorMsg}. Try a different approach.`,
        });
      }

      // 1j. 上下文压缩（后检查）
      session.messages = await this.context.preCompact(session, maxTokens);

      // ★ 累加上下文压缩调用的 token 消耗
      session.tokensUsed += this.context.getTokensSpentThisTurn();

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
      // ★ commit(): 将本会话快照合并进检索 store → 下次会话可检索
      this.episodicMemory.commit();

      // ★ 跨会话反思——每 N 个会话触发一次（优先用 flash 模型）
      if (this.episodicMemory.shouldReflect()) {
        const reflectLLM = this.contextLLM ?? this.llm;
        this.episodicMemory.reflect(reflectLLM).catch(() => {
          // 反思失败 → 静默降级，下次再试
        });
      }

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
    const allToolDefs = this.skillsLoader.activeTools();
    return {
      projectPath: this.config.project.projectPath,
      episodicMemory: this.episodicMemory,
      semanticMemory: this.semanticMemory,
      toolRetriever: createToolRetriever(allToolDefs),
      nativeTools: this.tools,
      engine: this,
    };
  }

  /**
   * 执行工具（Agent 3 SDB 桥接或 mock）
   */
  private async executeToolAsync(call: ToolCall): Promise<ToolResult> {
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
    const args = safeParseArgs(call.function.arguments);

    try {
      const result = await this.mcpClient!.callTool(
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
