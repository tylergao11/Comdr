# Agent 4 Architecture Plan — Comdr Engine

> 基于 2025-2026 年前沿论文 + Claude Code/OpenHands/SWE-agent 源码分析 + DeepSeek V4 适配
> 撰写日期: 2026-06-09

---

## 一、核心架构决策

### 1.1 主循环：单线程 Master Loop + 层级路由

**来源：Claude Code 源码分析 + BOAD (ICLR 2026)**

```
while turn < maxTurns && tokens < budget {

  1. prompt.build()          分层构造（固定前缀保证缓存命中）
  2. planner.route()         ★ 层级路由：任务类型 → thinking 模式 → 子智能体选择
  3. reasoning.capture()     ★ DeepSeek reasoning_content 生命周期管理
  4. llm.chatStream()        调用 DeepSeek
  5. if text                 → 流式输出, done
  6. if tool_calls            → for each:
     a. reflection.intra()   规则驱动的执行前预判
     b. tools.execute()      → SDB 6步 (Agent 3)
     c. reasoning.inject()   ★ reasoning_content 注入 tool result
     d. reflection.inter()   执行后审查（失败时调 LLM）
     e. memory.update()      双窗口增量更新
  7. progress.measure()      多维 progress signal
     → 检测停滞 → abort
  8. context.compact()       ★ 结构化锚定迭代摘要 (Factory AI 方案)
  9. loop
}
```

**关键决策：不做多 Agent 群集，做单线程 + 层级路由。**

理由：
- Claude Code 的 500K 行代码证明了单线程主循环的可行性
- BOAD 的层级分解通过 `planner.ts` 实现，但子智能体是"模式切换"而非独立进程
- Live-SWE-agent 的运行时自进化通过 `skills.ts` 实现
- 单线程 = 可调试、可审计、可恢复

**与 README 原方案的差异：**
- README 的 `planner.assess()` 只选 thinking 模式 → 扩展为层级路由（任务类型 + thinking + 子智能体）
- 新增 `reasoning` 子系统（DeepSeek 专用）
- `context.compact()` 从简单的四级压缩升级为结构化锚定迭代摘要

---

## 二、模块详细设计

### 2.1 `loop.ts` — 主循环骨架

**参考：Claude Code `queryLoop()` + SWE-agent ReAct 模式**

```typescript
// loop.ts 顶层设计
class Engine {
  async run(userInput: string): Promise<RunResult> {
    // 0. 会话初始化 / 恢复
    const session = await this.memory.loadOrCreate(userInput);

    // 1. 主循环
    while (session.turn < this.config.agent.maxTurns) {
      // 1a. Token 预算检查
      if (session.tokensUsed >= this.config.agent.tokenBudget) {
        return this.terminate('token_budget_exceeded', session);
      }

      // 1b. 上下文压缩（预检查）
      session.messages = await this.context.preCompact(session);

      // 1c. 构建 prompt
      const messages = this.prompt.build(session);

      // 1d. 任务路由
      const route = this.planner.route(session);

      // 1e. 调用 LLM
      const response = await this.llm.chatStream({
        messages,
        tools: this.skills.activeTools(),
        thinking: route.thinking,
        signal: this.abortController.signal,
      });

      // 1f. 保存 reasoning_content
      this.reasoning.capture(response.message);

      // 1g. 处理响应
      if (response.message.content && !response.message.tool_calls) {
        // 纯文本响应 → 流式输出 → 完成
        session.messages.push(response.message);
        return this.terminate('completed', session);
      }

      if (response.message.tool_calls) {
        session.messages.push(response.message);

        for (const call of response.message.tool_calls) {
          // Intra-reflection: 执行前预判
          const preCheck = this.reflection.intra(call, session);
          if (preCheck.abort) {
            return this.terminate(preCheck.reason, session);
          }
          if (preCheck.skip) continue;

          // 执行工具 (Agent 3 SDB)
          const result = await this.tools.execute(call);

          // ★ reasoning_content 注入 tool result
          const toolMessage = this.reasoning.wrapToolResult(call, result);

          session.messages.push(toolMessage);

          // Inter-reflection: 执行后审查
          const postCheck = await this.reflection.inter(call, result, session);
          if (postCheck.rollback && result.snapshotId) {
            await this.tools.rollback(result.snapshotId);
          }

          // 更新双窗口
          this.memory.updateStateWindow(result, session);
          this.memory.updateIntentWindow(call, result, session);
        }
      }

      // 1h. Progress check
      const signal = this.progress.measure(session);
      if (signal.stallDetected) {
        return this.terminate('stall_detected', session);
      }

      // 1i. 上下文压缩（后检查）
      session.messages = await this.context.postCompact(session);

      session.turn++;
    }

    return this.terminate('max_turns_reached', session);
  }
}
```

**10 种终止原因（参考 Claude Code）：**

| 终止原因 | 含义 | 是否成功 |
|----------|------|---------|
| `completed` | LLM 返回纯文本，任务完成 | ✅ |
| `max_turns` | 达到最大轮次 | ❌ |
| `token_budget_exceeded` | Token 超预算 | ❌ |
| `stall_detected` | Progress Meter 检测到停滞 | ❌ |
| `loop_detected` | Intra-reflection 检测到重复循环 | ❌ |
| `scope_drift` | Intra-reflection 检测到范围漂移 | ❌ |
| `user_aborted` | 用户中断 | ❌ |
| `tool_error_unrecoverable` | 工具执行不可恢复错误 | ❌ |
| `api_error_unrecoverable` | API 401/403 等不可重试错误 | ❌ |
| `timeout` | 全局超时 | ❌ |

---

### 2.2 `prompt.ts` — 分层 Prompt 构造

**参考：Claude Code 两区架构 + DeepSeek 自动前缀缓存**

```
┌────────────────────────────────────────────┐
│ ZONE 1: STATIC (缓存友好，不变)              │
├────────────────────────────────────────────┤
│ L1: System Prompt (不含时间戳)               │
│ L2: Tool Definitions (JSON.stringify sorted) │
│ L3: Session Anchor (会话摘要 + 持久记忆)      │
├────────────────────────────────────────────┤
│ ZONE 2: DYNAMIC (每轮变化)                   │
├────────────────────────────────────────────┤
│ L4: State Window (最近 5 条 WHAT)            │
│ L5: Intent Window (最近 5 条 WHY)            │
│ L6: Recent History (最近 5 轮完整消息)        │
│ L7: Current User Input                      │
└────────────────────────────────────────────┘
```

**关键设计：**
- L1-L3 保持绝对不变 → DeepSeek 全自动前缀缓存 100% 命中
- L4-L7 每轮变化，但总量控制在 ~8K tokens 以内
- System Prompt 不含任何时间戳、动态 ID、随机数
- Tool Definitions 序列化时 `Object.keys(tools).sort()` 保证稳定性

```typescript
class PromptConstructor {
  build(session: SessionState): Message[] {
    const staticZone = this.buildStaticZone(session);  // L1-L3, 缓存命中
    const dynamicZone = this.buildDynamicZone(session); // L4-L7, 每轮重建
    return [...staticZone, ...dynamicZone];
  }

  private buildStaticZone(session: SessionState): Message[] {
    return [
      this.systemPrompt(),           // L1: 不含时间戳
      this.toolDefinitions(),        // L2: sorted keys
      this.sessionAnchor(session),   // L3: 会话摘要
    ];
  }

  private buildDynamicZone(session: SessionState): Message[] {
    return [
      this.stateWindowMessage(session.stateWindow),    // L4
      this.intentWindowMessage(session.intentWindow),  // L5
      ...this.recentHistory(session.messages, 5),      // L6: 最近5轮
      { role: 'user', content: session.currentInput }, // L7
    ];
  }
}
```

---

### 2.3 `reasoning.ts` — DeepSeek reasoning_content 生命周期管理 ★ 新增

**来源：DeepSeek API 适配最佳实践（多个开源项目的血泪教训）**

这是 DeepSeek 独有的子系统。其他 LLM 不需要。

```typescript
class ReasoningManager {
  private cache: Map<string, string> = new Map(); // tool_call_id → reasoning_content

  /**
   * 从 API 响应中捕获 reasoning_content。
   * ★ 即使是空字符串也要保存！
   * 59% 的概率 reasoning_content 为空字符串，丢失 = 400 错误。
   */
  capture(message: Message): void {
    const rc = message.reasoning_content ?? '';
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        this.cache.set(tc.id, rc);
      }
    }
  }

  /**
   * ★ 将 reasoning_content 注入到 tool result 消息中。
   * DeepSeek 要求：有 tool_calls 的 assistant message 之后，
   * 所有后续请求必须包含 reasoning_content。
   */
  inject(messages: Message[]): Message[] {
    return messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.reasoning_content === undefined) {
        const rc = msg.tool_calls.length > 0
          ? this.cache.get(msg.tool_calls[0]!.id) ?? ''
          : '';
        return { ...msg, reasoning_content: rc };
      }
      return msg;
    });
  }

  /**
   * 处理历史消息中的缺失 reasoning_content。
   * 来自 Laravel AI PR #534 的方案。
   */
  repairHistory(messages: Message[]): Message[] {
    return messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.reasoning_content === undefined) {
        // 尝试从缓存恢复，失败则用空字符串
        return { ...msg, reasoning_content: '' };
      }
      return msg;
    });
  }

  /**
   * 上下文压缩后，确保被压缩的消息中的 reasoning_content 不丢失。
   */
  preserveAfterCompact(compactedMessages: Message[]): Message[] {
    return this.inject(compactedMessages);
  }
}
```

**DeepSeek API 调用时的参数清理：**

```typescript
// ★ thinking 启用时，必须删除这些参数
function sanitizeParams(params: ChatParams): any {
  const body: any = {
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    thinking: params.thinking,        // ★ 顶层字段
    reasoning_effort: params.thinking.type === 'enabled'
      ? params.thinking.effort        // 'high' | 'max'
      : undefined,
    max_tokens: params.maxTokens,
    stream: params.stream,
  };

  if (params.thinking.type === 'enabled') {
    delete body.tool_choice;    // 必须删
    delete body.temperature;    // 必须删
    delete body.top_p;          // 必须删
  }

  // 清理 undefined 字段
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  return body;
}
```

**为什么这个是 Agent 4 的职责而非 Agent 2？**
- Agent 2 (`@comdr/llm`) 是通用 DeepSeek API 客户端，不知道 agent 循环的存在
- `reasoning_content` 的生命周期跨越多轮对话，属于 Agent 4 的编排逻辑
- Agent 2 只需保证：原样返回 `reasoning_content`，不做任何过滤

---

### 2.4 `context.ts` — 结构化锚定迭代摘要

**参考：Factory AI Anchored Iterative Summarization + Claude Code 5-Layer Compaction**

**核心升级：从 README 的简单"四级压缩"升级为 Factory AI 的结构化锚定方案。**

```
触发阈值:
  FILL_LINE  = 80% token 预算 → 触发压缩
  DRAIN_LINE = 60% token 预算 → 压缩后目标

压缩管线（顺序执行，从便宜到贵）:

Stage 1: Observe (观察掩码) ← JetBrains "The Complexity Trap" 发现：简单掩码足够
  └→ 对超过 5 轮的历史消息，只保留 tool call name + ok/error，删除完整 output

Stage 2: Anchor (结构化锚定摘要) ← Factory AI 方案
  └→ 调用轻量 LLM summarize 最近被截断的消息段
  └→ 合并到持久化的结构化摘要中（不是全量重新生成！）

Stage 3: Collapse (虚拟投影) ← Claude Code 方案
  └→ 非破坏性：只在内存中替换，不修改持久化消息
  └→ 将旧消息替换为 [summary token] 占位符

Stage 4: Compact (完整压缩) ← 最后手段
  └→ 调 LLM 生成完整压缩版本
  └→ 保留双窗口内容的 anchor 引用
```

**结构化摘要格式（Factory AI 方案核心）：**

```typescript
interface StructuredSummary {
  // ★ 五个强制分区 —— 每个都必须显式填充或标记为空
  sessionIntent: string;       // 用户想要完成什么
  fileModifications: {         // ★ 最弱环节，需要特别设计
    path: string;
    action: 'created' | 'modified' | 'deleted';
    summary: string;           // 改了什么地方、为什么
  }[];
  decisions: {                 // 架构/设计决策
    what: string;
    why: string;
    turn: number;
  }[];
  nextSteps: string[];         // 恢复时应做什么
  openQuestions: string[];     // 未解决的问题
}
```

**与双窗口的关系：**
- State Window → 映射到 `fileModifications`（WHAT changed）
- Intent Window → 映射到 `decisions` + `nextSteps`（WHY changed + WHAT next）
- 压缩后，State/Intent Window 摘要注入回 prompt 的 L4/L5

```typescript
class ContextManager {
  private persistentSummary: StructuredSummary | null = null;

  async preCompact(session: SessionState): Promise<Message[]> {
    const usage = this.estimateTokens(session.messages);
    if (usage < this.fillLine(session)) return session.messages;

    // Stage 1: Observe
    let messages = this.applyObservationMask(session.messages);

    // Stage 2: Anchor (如果 Stage 1 不够)
    if (this.estimateTokens(messages) >= this.fillLine(session)) {
      const newSegment = this.extractRecentSegment(messages);
      const segmentSummary = await this.summarizeSegment(newSegment);
      this.persistentSummary = this.mergeSummary(this.persistentSummary, segmentSummary);
      messages = this.replaceWithAnchor(messages, newSegment, this.persistentSummary);
    }

    // Stage 3: Collapse (如果 Stage 2 还不够)
    if (this.estimateTokens(messages) >= this.fillLine(session)) {
      messages = this.collapseHistory(messages, session);
    }

    // Stage 4: Compact (最后手段)
    if (this.estimateTokens(messages) >= this.drainLine(session) * 1.1) {
      messages = await this.fullCompact(messages, session);
    }

    return messages;
  }
}
```

---

### 2.5 `memory/working.ts` — 双窗口工作记忆

**来源：Comdr 原创 + Factory AI 结构化摘要的理念映射**

```typescript
class WorkingMemory {
  private stateWindow: StateEntry[] = [];   // max 5
  private intentWindow: IntentEntry[] = []; // max 5
  private tempIdMap: Map<string, string> = new Map();

  /**
   * State Window 更新规则:
   * - 同 key 覆盖（如 'current_file' → 最新操作的文件）
   * - 超过 5 条时，淘汰最旧的（LRU）
   * - 只记录 WHAT：文件路径、操作类型、结果摘要
   */
  updateStateWindow(result: ToolResult, call: ToolCall): void {
    const entry: StateEntry = {
      key: this.deriveKey(call),       // 稳定 key，如 'edit:src/foo.ts'
      text: this.summarizeResult(result), // 如 "modified 3 lines: added error handling"
    };

    const idx = this.stateWindow.findIndex(e => e.key === entry.key);
    if (idx >= 0) {
      this.stateWindow[idx] = entry;  // 覆盖
    } else {
      this.stateWindow.push(entry);
      if (this.stateWindow.length > 5) this.stateWindow.shift();
    }
  }

  /**
   * Intent Window 更新规则:
   * - key 对应 StateEntry.key
   * - 记录 WHY：为什么要做这个操作
   * - 从 planner 的 task 描述或 tool call 的上下文中提取
   */
  updateIntentWindow(call: ToolCall, result: ToolResult, session: SessionState): void {
    const entry: IntentEntry = {
      key: this.deriveKey(call),
      why: this.inferIntent(call, session), // 如 "fix: type error in line 42"
      turn: session.turn,
    };

    const idx = this.intentWindow.findIndex(e => e.key === entry.key);
    if (idx >= 0) {
      this.intentWindow[idx] = entry;
    } else {
      this.intentWindow.push(entry);
      if (this.intentWindow.length > 5) this.intentWindow.shift();
    }
  }
}
```

---

### 2.6 `memory/episodic.ts` — 情景记忆

**参考：Factory AI 结构化摘要 + SimpleMem (ICML 2025)**

```typescript
class EpisodicMemory {
  /**
   * 会话结束时生成结构化摘要 + embedding
   * 使用 fastembed (轻量，无外部 API 依赖)
   */
  async consolidate(session: SessionState): Promise<EpisodeSummary> {
    const summary: EpisodeSummary = {
      id: session.id,
      timestamp: new Date().toISOString(),
      task: session.currentInput,
      outcome: session.outcome,
      // ★ 重用 context.ts 的结构化摘要
      structuredSummary: this.contextManager.getPersistentSummary(),
      tokensUsed: session.tokensUsed,
      turns: session.turn,
    };

    // 生成 embedding
    const text = this.serializeForEmbedding(summary);
    const embedding = await this.embedder.embed(text);

    // 存储: SQLite (元数据) + LanceDB (向量)
    await this.store.save(summary, embedding);

    return summary;
  }

  /**
   * 新会话时检索相关历史
   */
  async retrieve(userInput: string, topK: number = 3): Promise<EpisodeSummary[]> {
    const queryEmbedding = await this.embedder.embed(userInput);
    const results = await this.store.search(queryEmbedding, topK);
    return results;
  }
}
```

---

### 2.7 `memory/semantic.ts` — 语义记忆

**参考：SWE-agent ACI 设计 + tree-sitter AST**

```typescript
class SemanticMemory {
  /**
   * 四张关系图：
   * 1. Semantic Graph  — 符号定义/引用关系 (tree-sitter AST)
   * 2. Temporal Graph — 文件/符号的修改时间线
   * 3. Causal Graph   — 修改→测试失败的因果关系
   * 4. Entity Graph   — 类/函数/模块的依赖关系
   *
   * 增量更新：只重建受影响的文件
   */
}
```

---

### 2.8 `planner.ts` — 层级任务路由

**参考：BOAD (ICLR 2026) 层级分解 + DeepSeek thinking 模式路由**

```typescript
class TaskPlanner {
  /**
   * ★ 层级路由 = 任务分类 → thinking 模式 → 子智能体选择
   *
   * 不是 BOAD 的多 Agent，而是"模式切换"——同一个 LLM，
   * 不同的 system prompt 前缀和 thinking 配置。
   */
  route(session: SessionState): Route {
    const taskType = this.classify(session.currentInput);

    const mode: AgentMode = {
      query:      { thinking: 'disabled',       tools: ['read', 'search', 'glob'] },
      edit:       { thinking: 'enabled:high',   tools: ['read', 'write', 'edit', 'shell'] },
      generate:   { thinking: 'enabled:high',   tools: ['write', 'shell'] },
      refactor:   { thinking: 'enabled:max',    tools: ['read', 'edit', 'shell', 'git'] },
      architect:  { thinking: 'enabled:max',    tools: ['read', 'search', 'glob'] },
      orchestrate:{ thinking: 'enabled:max',    tools: ['all'] },
    }[taskType];

    return {
      taskType,
      thinking: this.resolveThinking(mode.thinking, session),
      allowedTools: mode.tools,
    };
  }

  /**
   * 动态重规划：如果连续 N 轮无进展，切换 thinking 模式
   */
  replan(session: SessionState, signal: ProgressSignal): Route | null {
    if (signal.stallCount >= 2) {
      // 升级 thinking effort
      return { /* 切换到 enabled:max */ };
    }
    if (signal.scopeDrift) {
      // 重新聚焦
      return { /* 回到原始任务 */ };
    }
    return null; // 不需要重规划
  }
}
```

---

### 2.9 `reflection.ts` — MIRROR 双重反思

**参考：Live-SWE-agent 轻量反射 + Claude Code 权限管线**

```typescript
class ReflectionEngine {
  /**
   * Intra-reflection: 执行前预判（规则驱动，不调 LLM）
   *
   * 检查三项:
   * 1. 循环检测: 同一 tool + 同一 args 连续 ≥3 次
   * 2. 范围漂移: 操作超出当前 task 定义的范围
   * 3. 策略评估: 当前方法是否已经失败过
   */
  intra(call: ToolCall, session: SessionState): IntraResult {
    // 循环检测
    if (this.detectLoop(call, session)) {
      return { abort: true, reason: 'loop_detected',
               feedback: 'You have made the same tool call 3 times. Stop and reconsider.' };
    }

    // 范围漂移检测
    if (this.detectScopeDrift(call, session)) {
      return { abort: false, skip: false,
               warning: 'This operation seems outside the current task scope.' };
    }

    return { abort: false, skip: false };
  }

  /**
   * Inter-reflection: 执行后审查（失败时调 LLM）
   *
   * 检查三项:
   * 1. 结果验证: 工具输出是否符合预期？
   * 2. 根因分析: 如果失败，为什么？
   * 3. 质量评估: 修改质量如何？
   */
  async inter(call: ToolCall, result: ToolResult, session: SessionState): Promise<InterResult> {
    if (result.ok) return { rollback: false };

    // ★ 失败时调 LLM 做根因分析
    const analysis = await this.llm.chat({
      messages: [
        { role: 'system', content: 'Analyze why this tool call failed and suggest next steps.' },
        { role: 'user', content: `Tool: ${call.function.name}(${call.function.arguments})\nError: ${result.content}` },
      ],
      thinking: { type: 'disabled' }, // 分析不需要 thinking
    });

    return {
      rollback: result.snapshotId !== undefined,
      feedback: analysis.message.content,
    };
  }

  private detectLoop(call: ToolCall, session: SessionState): boolean {
    const recent = session.messages.slice(-6); // 最近 3 对 call+result
    const sameCall = recent.filter(m =>
      m.role === 'assistant' &&
      m.tool_calls?.some(tc =>
        tc.function.name === call.function.name &&
        tc.function.arguments === call.function.arguments
      )
    );
    return sameCall.length >= 3;
  }
}
```

---

### 2.10 `progress.ts` — 多维 Progress Meter

**参考：Comdr 原创 + Claude Code 的 10 种终止原因**

```typescript
class ProgressMeter {
  /**
   * ★ 从简单二值"零进展=abort"升级为多维信号
   */
  measure(session: SessionState): ProgressSignal {
    const recentTurns = this.getRecentTurns(session, 3);

    return {
      // 传统信号
      diffChanges: this.countDiffChanges(recentTurns),
      testDelta: this.countTestChanges(recentTurns),
      infoGained: this.countInfoGained(recentTurns),
      intentProgress: this.checkIntentProgress(session),
      toolSuccesses: this.countToolSuccesses(recentTurns),

      // ★ 新增：停滞检测信号
      stallCount: this.countStallTurns(recentTurns),
      loopPattern: this.detectLoopPattern(recentTurns),
      sameFileRepeat: this.countSameFileRepeat(recentTurns),
      emptyOutputCount: this.countEmptyOutputs(recentTurns),

      // ★ 综合得分
      score: 0, // 由 computeScore() 计算
    };
  }

  computeScore(signal: ProgressSignal): number {
    let score = 0;
    score += signal.diffChanges * 2;
    score += Math.max(0, signal.testDelta) * 5;
    score += signal.infoGained;
    score += signal.intentProgress ? 3 : 0;
    score += signal.toolSuccesses * 2;

    // ★ 罚分
    score -= signal.loopPattern ? 5 : 0;
    score -= signal.sameFileRepeat > 3 ? 3 : 0;
    score -= signal.emptyOutputCount * 2;

    return score;
  }

  /**
   * ★ 三态停滞检测：
   * - 连续 2 轮 score≤0 → warning（注入反思提示）
   * - 连续 3 轮 score≤0 → abort
   * - 连续 2 轮同 tool+同 args → 立即 abort
   */
  isStalled(signal: ProgressSignal): boolean {
    return signal.stallCount >= 3 || signal.loopPattern;
  }
}
```

---

### 2.11 `skills.ts` — 渐进式 Skills 加载

**参考：Live-SWE-agent 运行时工具生成 + Claude Code Skills 系统**

```typescript
class SkillsLoader {
  /**
   * ★ 启动只注入 name + description（渐进式）
   * LLM 调用 skill → 正文注入下一轮
   *
   * ★ 新增：Live-SWE-agent 式的运行时 Skill 创建
   * Agent 可以创建自己的 skill（Python/Bash 脚本），
   * 立即成为下一轮可用的工具
   */
  private registry: Map<string, SkillDefinition> = new Map();
  private runtimeSkills: Map<string, RuntimeSkill> = new Map();

  activeTools(): ToolDefinition[] {
    const builtin = this.getBuiltinTools();
    const active = this.getActiveSkills();
    const runtime = this.getRuntimeSkills();
    return [...builtin, ...active, ...runtime];
  }

  /**
   * ★ Live-SWE-agent 式运行时工具创建
   * Agent 写了脚本后，自动注册为可调用 tool
   */
  registerRuntimeSkill(path: string, definition: SkillDefinition): void {
    this.runtimeSkills.set(definition.name, {
      path,
      definition,
      createdAt: Date.now(),
    });
  }
}
```

---

## 三、与其他论文/系统的对标

| 论文/系统 | 核心思想 | Comdr 对应模块 | 适配说明 |
|-----------|---------|---------------|---------|
| **Claude Code** | 单线程主循环 + 5层压缩 | `loop.ts` + `context.ts` | 不照搬 500K 行，取其核心模式 |
| **Factory AI** | 结构化锚定迭代摘要 | `context.ts` | ★ 直接采用，5 个强制分区 |
| **BOAD (ICLR 2026)** | 层级分解 + Bandit 搜索 | `planner.ts` | 简化为"模式切换"而非多 Agent |
| **Live-SWE-agent** | 运行时自进化 | `skills.ts` | ★ 运行时 skill 创建 |
| **SWE-agent** | ACI 设计原则 | `@comdr/tools` (Agent 3) | 简单/紧凑/信息丰富/防护 |
| **OpenHands** | CodeAct + Condenser | `loop.ts` + `context.ts` | ReAct 循环 + 冷凝器 |
| **JetBrains Complexity Trap** | 简单掩码 ≥ LLM 摘要 | `context.ts` Stage 1 | ★ 先掩码，不够再摘要 |
| **SWE-Compressor/CAT** | 压缩为可调用工具 | 未来方向 | 当前阶段不实现，成本太高 |

---

## 四、DeepSeek V4 适配清单

| # | 要点 | 实现位置 | 优先级 |
|---|------|---------|--------|
| 1 | `reasoning_content` 捕获（含空字符串） | `reasoning.ts` capture() | 🔴 P0 |
| 2 | `reasoning_content` 注入后续请求 | `reasoning.ts` inject() | 🔴 P0 |
| 3 | 历史消息修复（缺失 reasoning_content） | `reasoning.ts` repairHistory() | 🔴 P0 |
| 4 | thinking 启用时删除 tool_choice/temperature/top_p | Agent 2 `client.ts` | 🔴 P0 |
| 5 | thinking 是顶层字段，不是 extra_body | Agent 2 `client.ts` | 🔴 P0 |
| 6 | 不发送 cache_control（DeepSeek 自动缓存） | Agent 2 `client.ts` | 🟡 P1 |
| 7 | Tool definitions JSON.stringify(sorted keys) | `prompt.ts` | 🟡 P1 |
| 8 | System prompt 不含时间戳 | `prompt.ts` | 🟡 P1 |
| 9 | 区分 deepseek-reasoner vs V4 thinking 模式 | Agent 2 `client.ts` | 🟡 P1 |
| 10 | 上下文压缩后 reasoning_content 不丢失 | `context.ts` + `reasoning.ts` | 🟡 P1 |

---

## 五、实现顺序建议

```
Phase 1 (核心骨架):
  loop.ts → prompt.ts → reasoning.ts
  (能跑通最简单的 "hello world" 无 tool call)

Phase 2 (记忆系统):
  memory/working.ts → context.ts (Stage 1+2)
  (双窗口更新 + 基本压缩)

Phase 3 (智能路由):
  planner.ts → reflection.ts → progress.ts
  (任务路由 + 循环检测 + 停滞检测)

Phase 4 (完整记忆):
  memory/episodic.ts → memory/semantic.ts → memory/persistent.ts
  (跨会话记忆 + 代码索引 + 持久化)

Phase 5 (扩展):
  skills.ts → 集成测试 → 性能调优
```

---

## 六、与 Agent 1/2/3 的接口依赖

| 我需要从 Agent 1 拿到的类型 | 用途 |
|---------------------------|------|
| `Message`, `ToolCall`, `ToolResult`, `ToolDefinition` | 核心数据结构 |
| `AgentEvent`, `AgentConfig` | 事件流 + 配置 |
| `StateEntry`, `IntentEntry`, `SessionState` | 双窗口 |
| `ProgressSignal` | 进度检测 |
| `IDeepSeekClient` 接口 | 契约 A |
| `INativeTools` 接口 | 契约 B |

| 我需要从 Agent 2 拿到的 | 用途 |
|------------------------|------|
| `DeepSeekClient` 实现 `IDeepSeekClient` | LLM 调用 |
| `ChatParams`, `ChatResponse` | 请求/响应类型 |
| 保证 `reasoning_content` 原样返回 | 不丢字段 |

| 我需要从 Agent 3 拿到的 | 用途 |
|------------------------|------|
| `execute(opts)` → `ToolExecuteResult` | 工具执行 |
| `rollback(snapshotId)` | 回滚 |
| SDB 6 步管线正常工作 | 可靠执行 |

---

## 七、关键风险与缓解

| 风险 | 可能性 | 缓解 |
|------|--------|------|
| DeepSeek reasoning_content 在压缩后丢失 | 中 | `reasoning.ts` 独立缓存 + repairHistory |
| 前缀缓存因压缩失效 | 中 | L1-L3 绝对不变，只压缩 L6 |
| 结构化摘要质量不够 | 中 | 轻量 LLM 调用 + 强制分区格式 |
| 循环检测误判 | 低 | 3 次阈值而非 2 次 |
| Planner 任务分类错误 | 中 | 默认降级到全工具模式 |
