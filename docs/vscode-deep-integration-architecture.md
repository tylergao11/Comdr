# Comdr × VS Code 深度集成架构

> 基于 10+ 篇前沿 paper 的研究结论 + Comdr 现有模块映射。
> 核心命题：放弃终端，以 VS Code fork 方式深度集成，达到 DeepSeek 级别的深度适配。

---

## 一、深度集成的定义：就像深度适配 DeepSeek 一样集成 VS Code

| DeepSeek 深度适配 | 做了什么 | VS Code 深度集成的等价物 |
|---|---|---|
| `reasoning_content` 保留并回注 | 利用 DeepSeek 独有的 thinking 机制 | 利用 VS Code 独有的 LSP 语义模型（类型图/CFG/引用链） |
| Chat Prefix Completion 强制纠正 | 利用 DeepSeek beta endpoint | 利用 VS Code 的 TextModel 原生 undo stack |
| 工具定义 sorted_keys 序列化 | 利用 DeepSeek 前缀缓存机制 | 利用 VS Code 的 Extension Host 进程隔离 |
| thinking 参数顶层管理 | 利用 DeepSeek API 独有参数 | 利用 VS Code 的 Debug Adapter Protocol |
| 全自动前缀缓存 >95% | 极致利用平台特性 | 极致利用 IDE 平台特性（不是通用扩展 API） |

**关键认知**：浅层扩展用 VS Code Extension API，深度集成用 VS Code 内部架构。就像浅层调 LLM 用 OpenAI 兼容 API，深度适配 DeepSeek 用它的独有特性。

---

## 二、现有 Comdr 架构（终端优先 → 目标：编辑器优先）

```
                            ┌──────────────────────────────┐
                            │    人类 (大哥)                 │
                            └──────────────┬───────────────┘
                                           │ 终端输入
                                           ▼
┌── Agent 5: @comdr/ui ──────────────────────────────────────────┐
│  cli.ts        → 命令解析                                       │
│  tui/index.ts  → 终端 UI (reducer + colors + utils)            │
│  mcp-server.ts → MCP JSON-RPC endpoint                         │
│  app-server.ts → (预留) Web 服务                                │
│  mock-engine.ts→ 测试用 mock                                    │
│                                                                  │
│  消费: IEngine.run() → AsyncGenerator<AgentEvent>               │
│  ★ 终端是唯一交互面                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Contract C: AsyncGenerator<AgentEvent>
┌──────────────────────────▼──────────────────────────────────────┐
│  Agent 4: @comdr/engine (编排核心)                               │
│                                                                  │
│  loop.ts ─── 主循环 9 步 (每 turn)                              │
│    ┌──────────────────────────────────────────────────┐         │
│    │ Step 1: prompt.build()     分层构造 + 静态指纹    │         │
│    │ Step 2: planner.route()    6模式关键词路由        │         │
│    │ Step 3: reasoning.inject() reasoning_content 注入 │         │
│    │ Step 4: llm.chatStream()   调 DeepSeek            │         │
│    │ Step 5: if text → 流式输出, done                   │         │
│    │ Step 6: if tool_calls →                            │         │
│    │   a. reflection.intra()   执行前预检               │         │
│    │   b. tools.execute()      SDB 6步管线 (Agent 3)    │         │
│    │   c. reasoning.capture()  捕获推理链               │         │
│    │   d. reflection.inter()   执行后审查               │         │
│    │   e. reflection.selfCorrect() DeepSeek prefix 纠正 │         │
│    │   f. memory.update()      双窗口增量更新           │         │
│    │ Step 7: progress.measure() 停滞检测 → abort        │         │
│    │ Step 8: context.compact()  结构化锚定迭代摘要       │         │
│    └──────────────────────────────────────────────────┘         │
│                                                                  │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐   │
│  │ prompt.ts   │ │planner.ts│ │reasoning.ts│ │reflection.ts │   │
│  │ 7层prompt   │ │层级路由  │ │think管理   │ │MIRROR反思    │   │
│  └─────────────┘ └──────────┘ └───────────┘ └──────────────┘   │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐   │
│  │ context.ts  │ │progress.ts│ │skills.ts  │ │scheduler.ts  │   │
│  │ 同步压缩    │ │停滞检测   │ │渐进加载   │ │拓扑并行      │   │
│  └─────────────┘ └──────────┘ └───────────┘ └──────────────┘   │
│                                                                  │
│  Memory System ──────────────────────────────────────┐          │
│  ┌──────────────────┐ ┌─────────────────┐            │          │
│  │ working.ts       │ │ episodic.ts     │            │          │
│  │ State+Intent双窗口│ │ 情景记忆+embed  │            │          │
│  └──────────────────┘ └─────────────────┘            │          │
│  ┌──────────────────┐ ┌─────────────────┐            │          │
│  │ semantic.ts      │ │ procedural.ts   │            │          │
│  │ 代码索引四张图    │ │ 跨项目模式提取   │            │          │
│  └──────────────────┘ └─────────────────┘            │          │
│                                                       │          │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │          │
│  │world-model│ │subagent  │ │retrieval │ │repo-map│ │          │
│  │COMDR.md   │ │fanOut等  │ │BM25+向量 │ │Aider式 │ │          │
│  └───────────┘ └──────────┘ └──────────┘ └────────┘ │          │
│                                                       │          │
│  ┌───────────┐ ┌──────────────┐                       │          │
│  │mcp-client │ │self-check.ts │                       │          │
│  │MCP桥接    │ │确定性规则管线  │                       │          │
│  └───────────┘ └──────────────┘                       │          │
└──┬──────────────────────┬──────────────────────────────┘
   │ Contract A           │ Contract B
   │ IDeepSeekClient      │ INativeTools
┌──▼──────────────┐  ┌───▼──────────────────────────────────┐
│ Agent 2: @comdr/llm│  │ Agent 3: comdr-tools (Rust/napi)    │
│ client.ts       │  │                                      │
│ - chat()/stream │  │ SDB 6-step pipeline (sdb.rs)         │
│ - reasoning保留 │  │  1.Schema Validate                   │
│ - prefix缓存    │  │  2.Permission Check                  │
│ - 429/5xx重试   │  │  3.Pre-snapshot (snapshot.rs)         │
│ prompt-cache.ts │  │  4.Execute + timeout                  │
└─────────────────┘  │  5.Diff Validate                     │
                     │  6.Test Feedback (sdb/test_feedback)  │
                     │                                      │
                     │ Tools (tools/*.rs):                   │
                     │  file.rs | git.rs | shell.rs | lsp.rs │
                     │                                      │
                     │ bootstrap.rs: 符号+引用扫描            │
                     └──────────────────────────────────────┘
                     ┌──────────────────────────────────────┐
                     │ Agent 1: @comdr/core                 │
                     │ types.ts | contracts.ts | config.ts  │
                     │ logging.ts (IEventLogger)            │
                     │ (纯类型 + 常量 + 5 契约)              │
                     └──────────────────────────────────────┘

★ 关键瓶颈（终端优先模式）:
  ❌ 没有 LSP 反馈 → self-correct 只靠 LLM 自省
  ❌ 上下文是纯文本 → 没有 AST/类型图注入
  ❌ 用户交互是终端 → 没有 diff preview/accept/reject UI
  ❌ 工具输出是文本 → Agent 无法利用 IDE 的语义能力
```

---

## 三、7 层深度集成架构（论文驱动）

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    Comdr × VS Code 深度集成 7 层架构                          ║
║                    每一层都对应一篇前沿 paper 的设计                            ║
╚═══════════════════════════════════════════════════════════════════════════════╝

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 6: MEDIATOR (人↔Agent↔IDE 统一协调)                               │
 │ Paper: TU Delft "LLM-based Mediator Agents" (FSE 2025)                   │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │                    人类 (大哥)                                 │      │
 │  │          审核方案 | 做决策 | 纠正方向                           │      │
 │  └────────────────────────┬─────────────────────────────────────┘      │
 │                           │                                            │
 │  ┌────────────────────────▼─────────────────────────────────────┐      │
 │  │              Mediator Agent (新的顶层模块)                      │      │
 │  │  ┌──────────────────────────────────────────────────────┐    │      │
 │  │  │ 自动编排决策:                                          │    │      │
 │  │  │   "修复类型错误" → IDE LSP 诊断 + Comdr 代码生成       │    │      │
 │  │  │   "重构这个模块" → IDE 重构引擎 + Agent 生成新实现      │    │      │
 │  │  │   "写测试"       → IDE 测试覆盖率 + Agent 生成用例     │    │      │
 │  │  │   "审查 PR"      → IDE diff + Agent 逐文件审查         │    │      │
 │  │  └──────────────────────────────────────────────────────┘    │      │
 │  │                                                               │      │
 │  │  ★ 关键创新: 不是人在 IDE 里调 Agent，而是 Mediator 自动判断  │      │
 │  │    这个任务该用 IDE 的哪个功能 + Agent 的哪个能力             │      │
 │  └──────┬──────────────┬──────────────────┬─────────────────────┘      │
 │         │              │                  │                            │
 │    ┌────▼────┐   ┌─────▼─────┐   ┌───────▼───────┐                    │
 │    │ IDE 工具 │   │Agent 工具  │   │ 外部 Agent 系统 │                   │
 │    │ LSP/调试 │   │ 代码生成   │   │ 测试/部署 Agent │                   │
 │    │ 重构/搜索│   │ 审查/分析  │   │                 │                    │
 │    └─────────┘   └───────────┘   └─────────────────┘                    │
 │                                                                         │
 │  ★ 新建模块: @comdr/vscode/src/mediator.ts                              │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 5: PROCESS REWARD (LSP 诊断差值 = 奖励信号)                        │
 │ Paper: Princeton "Lanser-CLI" (arXiv:2510.22907, Oct 2025)               │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │  Agent 改代码 → LSP 跑诊断                                     │      │
 │  │       │                                                        │      │
 │  │       ▼                                                        │      │
 │  │  ┌────────────────────────────────────────────────────┐      │      │
 │  │  │ 奖励函数: r_t = α(D_{t-1} - D_t) + βS_t - γ(1-conf)  │      │      │
 │  │  │                                                    │      │      │
 │  │  │ D_{t-1} - D_t = 诊断数减少了多少 (越少越好)         │      │      │
 │  │  │ S_t           = 安全检查通过 (+1) 或失败 (-1)       │      │      │
 │  │  │ conf_t        = Agent 对本次修改的置信度             │      │      │
 │  │  └────────────────────────────────────────────────────┘      │      │
 │  │       │                                                        │      │
 │  │       ▼                                                        │      │
 │  │  ┌────────────────────────────────────────────────────┐      │      │
 │  │  │ Analysis Bundle (确定性、可回放产物)                  │      │      │
 │  │  │  - 哈希: SHA256(LSP version + code + config)        │      │      │
 │  │  │  - 用于: CI 可复现 | 离线训练 | 回归检测             │      │      │
 │  │  └────────────────────────────────────────────────────┘      │      │
 │  │                                                                │      │
 │  │  ★ 关键创新: Self-Correct 不再靠 LLM "觉得自己错了"           │      │
 │  │    → 编译器说错就是错。诊断差值可量化、可训练。                 │      │
 │  │                                                                │      │
 │  │  ★ 改造模块: reflection.ts → 增加 LSP reward 路径              │      │
 │  │  ★ 新建模块: @comdr/vscode/src/lsp-reward.ts                   │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 4: AGENT-NATIVE SEMANTICS (认知级工具)                             │
 │ Paper: LSAP "Language Server Agent Protocol" (2025)                      │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │  人类工具                     vs        Agent 认知工具         │      │
 │  │  ─────────────────────────────────────────────────────────   │      │
 │  │  file_read(path)              →   understand_symbol(name)    │      │
 │  │  file_grep(pattern)           →                               │      │
 │  │  symbol_find(name)            →   一次请求 → LSP编排          │      │
 │  │  (3 次调用, 脆弱寻址)              → 完整 Markdown 报告       │      │
 │  │                                                               │      │
 │  │  file_edit(path, diff)        →   rename_symbol(old, new)     │      │
 │  │                                   (两阶段: preview→execute)   │      │
 │  │                                   LSP 保证所有引用更新        │      │
 │  │                                                               │      │
 │  │  shell_bash("npm test")       →   verify_changes()            │      │
 │  │                                   (自动识别受影响的测试)      │      │
 │  │                                                               │      │
 │  │  ★ 关键创新: 工具不再是对 IDE API 的薄封装                      │      │
 │  │    → 而是重新设计给 Agent 认知模型用的高级操作                  │      │
 │  │    → 一次调用 = 后台编排多个 LSP 原子操作 + 结构化输出          │      │
 │  │                                                               │      │
 │  │  ★ 新建模块: @comdr/vscode/src/agent-tools.ts                 │      │
 │  │  ★ 改造模块: tools/advanced-tools.ts → 增加 LSP 语义工具      │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 3: AGENT PLATFORM (IDE = Agent 管理面板)                           │
 │ Paper: Marron "A New Generation of Intelligent Development Environments" │
 │        (ACM IDE Workshop 2024)                                           │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │                                                               │      │
 │  │  VS Code 窗口布局 (重新设计):                                   │      │
 │  │                                                               │      │
 │  │  ┌──────────────┬─────────────────────────┬────────────┐     │      │
 │  │  │ Agent 面板    │  Diff Viewer (主区域)    │ Chat/对话   │     │      │
 │  │  │              │                        │            │     │      │
 │  │  │ ▸ Agent 1    │  ┌─────────────────┐   │ [User]     │     │      │
 │  │  │   重构 auth  │  │ - old code       │   │  重构 auth │     │      │
 │  │  │   2/5 完成   │  │ + new code       │   │            │     │      │
 │  │  │              │  │   LSP ✅ 无错误  │   │ [Agent]    │     │      │
 │  │  │ ▸ Agent 2    │  └─────────────────┘   │  方案A:     │     │      │
 │  │  │   审查 PR#42 │                        │  提取中间件 │     │      │
 │  │  │   等待审核    │  ┌─────────────────┐   │  方案B:     │     │      │
 │  │  │              │  │ 重构中的文件      │   │  内联简化  │     │      │
 │  │  │ ▸ Agent 3    │  │ (LSP实时反馈)    │   │            │     │      │
 │  │  │   写测试      │  └─────────────────┘   │ [大哥]     │     │      │
 │  │  │   运行中...   │                        │  方案A ✅  │     │      │
 │  │  │              │                        │            │     │      │
 │  │  └──────────────┴─────────────────────────┴────────────┘     │      │
 │  │                                                               │      │
 │  │  ★ 关键创新: 人从"打字者"变成"管理者"                          │      │
 │  │    → 不再逐行写代码，而是审核 Agent 的方案                       │      │
 │  │    → 多 Agent 并行，人在多个方案中做决策                        │      │
 │  │                                                               │      │
 │  │  ★ 新建模块: @comdr/vscode/src/dashboard.ts (Webview Panel)   │      │
 │  │  ★ 改造模块: subagent.ts → 增加 VS Code 可视化管理面           │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 2: STRUCTURAL CONTEXT (AST/CFG/类型图 → LLM 上下文)               │
 │ Paper: Cipollone / JetBrains "PSI-based LLM Integration" (FSE 2025)     │
 │        ★ Recall@1 提升 20%（有数据支撑）                                 │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │                                                               │      │
 │  │  当前 Comdr 上下文注入 (纯文本):                                 │      │
 │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │      │
 │  │  │ BM25检索  │ │Repo Map  │ │WorldModel│ │ Episodic     │    │      │
 │  │  │ (关键词)  │ │(文件列表) │ │(COMDR.md)│ │ (跨会话)     │    │      │
 │  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │      │
 │  │                                                               │      │
 │  │  深度集成新增 (结构化语义):                                      │      │
 │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │      │
 │  │  │ AST 节点  │ │类型推导图│ │调用链图  │ │ 引用关系图    │    │      │
 │  │  │(当前文件) │ │(LSP hovers)│(LSP calls)│ │(LSP refs)    │    │      │
 │  │  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │      │
 │  │       │             │            │            │               │      │
 │  │       └─────────────┴────────────┴────────────┘               │      │
 │  │                          │                                     │      │
 │  │                          ▼                                     │      │
 │  │  ┌────────────────────────────────────────────────────┐      │      │
 │  │  │ 结构化上下文注入 (替换/增强纯文本 Repo Map)            │      │      │
 │  │  │                                                    │      │      │
 │  │  │ 文件: src/auth/login.ts                             │      │      │
 │  │  │ ├── exports: LoginHandler, validateSession          │      │      │
 │  │  │ ├── imports: jwt.verify, UserModel.findById         │      │      │
 │  │  │ ├── 调用者: src/routes/auth.ts (3 sites)            │      │      │
 │  │  │ ├── 类型依赖: UserSession, AuthToken, LoginRequest  │      │      │
 │  │  │ └── 测试文件: __tests__/auth/login.test.ts          │      │      │
 │  │  │                                                    │      │      │
 │  │  │ ★ 这不是"文本搜索"——这是 LSP 语义推导               │      │      │
 │  │  │ ★ 来自 JetBrains PSI 论文: Recall@1 +20%            │      │      │
 │  │  └────────────────────────────────────────────────────┘      │      │
 │  │                                                               │      │
 │  │  ★ 改造模块: world-model.ts → 增加 LSP 语义管道               │      │
 │  │  ★ 改造模块: semantic.ts → 注入 LSP 类型图 (替代纯文本索引)   │      │
 │  │  ★ 新建模块: @comdr/vscode/src/structural-context.ts          │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 1: SHADOW WORKSPACE (隔离 LSP 验证闭环)                            │
 │ System: Cursor "Shadow Workspace" (已移除但设计可借鉴)                   │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │                                                               │      │
 │  │   用户窗口 (正常编辑)           Shadow 隐藏窗口 (Agent 编辑)    │      │
 │  │   ┌─────────────────┐          ┌─────────────────────┐       │      │
 │  │   │ src/auth.ts     │          │ src/auth.ts (copy)   │       │      │
 │  │   │ (用户正在编辑)   │          │ + Agent 的修改       │       │      │
 │  │   │                 │          │                      │       │      │
 │  │   │ LSP Server      │          │ LSP Server (独立实例) │       │      │
 │  │   │ → 用户看到的诊断 │          │ → Agent 看到的诊断   │       │      │
 │  │   └─────────────────┘          └──────────┬──────────┘       │      │
 │  │                                           │                   │      │
 │  │                                    ┌──────▼──────────┐       │      │
 │  │                                    │ LSP 诊断反馈     │       │      │
 │  │                                    │ 3 处 type error  │       │      │
 │  │                                    │ 1 unused import  │       │      │
 │  │                                    └──────┬──────────┘       │      │
 │  │                                           │                   │      │
 │  │                                    ┌──────▼──────────┐       │      │
 │  │                                    │ Agent 自动修复   │       │      │
 │  │                                    │ (最多 3 轮)       │       │      │
 │  │                                    │ 3轮未修复 → 问人  │       │      │
 │  │                                    └──────┬──────────┘       │      │
 │  │                                           │                   │      │
 │  │                              ┌────────────▼───────────┐      │      │
 │  │                              │ 修复后 diff 呈现给用户 │      │      │
 │  │                              │ Accept / Reject / Edit │      │      │
 │  │                              └────────────────────────┘      │      │
 │  │                                                               │      │
 │  │  ★ 关键创新: Agent 写的代码在你看到之前已经过了 LSP 验证       │      │
 │  │    → 不再是 "Agent 说修好了" → 你手动检查 → "根本没修"        │      │
 │  │                                                               │      │
 │  │  ★ 实现要求: VS Code fork（扩展 API 无法创建隐藏窗口+独立LSP）│      │
 │  │  ★ 新建模块: @comdr/vscode/src/shadow-workspace.ts            │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Layer 0: ACI PRIMITIVES (确定性基元)                                     │
 │ Paper: MoonBit "ACI Six Pillars" (HKUST 2025)                            │
 │                                                                         │
 │  ┌──────────────────────────────────────────────────────────────┐      │
 │  │                                                               │      │
 │  │  六柱映射到 Comdr 现有/新增模块:                                │      │
 │  │                                                               │      │
 │  │  ┌────────────────────────┬─────────────────────────────────┐│      │
 │  │  │ Pillar                  │ Comdr 实现                      ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 1. Flattened Syntax    │ LSP AST 标准化输出(而非代码原文) ││      │
 │  │  │    Agent 看到 AST       │ ★ 新增: Rust AST dump tool      ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 2. Manifest Types      │ LSP hover → 类型注入 context    ││      │
 │  │  │    类型信息前置         │ ★ 改造: prompt.ts 增加类型层     ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 3. Built-in Testability │ SDB Step 6 Test Feedback       ││      │
 │  │  │    内置可测试性         │ ★ 已有: sdb/test_feedback.rs    ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 4. Sandboxed Build      │ Shadow Workspace + Snapshot     ││      │
 │  │  │    沙箱编译             │ ★ 已有: snapshot.rs             ││      │
 │  │  │                        │ ★ 新增: VS Code Task 沙箱        ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 5. Machine Diagnostics  │ Analysis Bundle (确定性可回放)  ││      │
 │  │  │    结构化诊断           │ ★ 已有: unified [OK]/[ERR] 格式 ││      │
 │  │  │                        │ ★ 新增: LSP Diagnostic JSON     ││      │
 │  │  ├────────────────────────┼─────────────────────────────────┤│      │
 │  │  │ 6. Human/AI Balance    │ 人看 diff, Agent 看 AST diff    ││      │
 │  │  │    双导向               │ ★ 新增: dual-format diff engine ││      │
 │  │  └────────────────────────┴─────────────────────────────────┘│      │
 │  │                                                               │      │
 │  │  ★ 关键创新: ACI 层是基础设施，Layer 1-6 都建立在这上面         │      │
 │  │  ★ 部分已有 (SDB pipeline, unified output)，需扩展             │      │
 │  │  ★ 改造模块: sdb.rs, snapshot.rs → ACI 规范化                  │      │
 │  └──────────────────────────────────────────────────────────────┘      │
 └─────────────────────────────────────────────────────────────────────────┘
```

---

## 四、模块映射总表

```
当前 Comdr 模块                     → 深度集成后的位置/角色
═══════════════════════════════════════════════════════════════════════════

@comdr/core (Agent 1)              → 不变。类型+契约层仍然是唯一真理源
  types.ts                         → + VS Code 相关类型 (EditorContext, LSPDiagnostic 等)
  contracts.ts                     → + Contract F: IVSCodeHost (VS Code 宿主契约)

@comdr/llm (Agent 2)               → 不变。DeepSeek 集成已成熟
  client.ts                        → 无变化
  prompt-cache.ts                  → 无变化

comdr-tools (Agent 3, Rust)        → 大幅扩展
  sdb.rs                           → + Step 7: LSP Validate (Layer 0,1)
  sdb/test_feedback.rs             → + LSP diagnostic delta reward (Layer 5)
  snapshot.rs                      → + Analysis Bundle hashing (Layer 5)
  tools/lsp.rs                     → ★ 核心扩展: 完整 LSP 客户端 (Layer 2,4)
  bootstrap.rs                     → + LSP 语义扫描 (替代纯正则) (Layer 2)
  + tools/ast.rs (NEW)             → AST dump tool (Layer 0)
  + aci.rs (NEW)                   → ACI 基元抽象层 (Layer 0)

@comdr/engine (Agent 4)            → 核心改造
  loop.ts                          → + 接收 LSP 诊断事件 (Layer 1,5)
  prompt.ts                        → + 类型信息/调用链 注入层 (Layer 2)
  planner.ts                       → + Mediator 决策逻辑 (Layer 6)
  reflection.ts                    → + LSP reward 替代 LLM 自省 (Layer 5)
  context.ts                       → + 结构化上下文压缩 (Layer 2)
  self-check.ts                    → + LSP 诊断规则 (Layer 0)
  memory/working.ts                → + 编辑器状态窗口 (当前文件/光标等)
  memory/semantic.ts               → + LSP 类型图索引 (替代纯文本) (Layer 2)
  world-model.ts                   → + LSP 语义管道 (Layer 2)
  tools/advanced-tools.ts          → + Agent-native 语义工具 (Layer 4)

@comdr/vscode (NEW, Agent 6)       → ★★★ 全新包
  src/index.ts                     → 激活入口 (VS Code Extension activate)
  src/shadow-workspace.ts          → 隐藏窗口 + 独立 LSP (Layer 1)
  src/structural-context.ts        → AST/CFG/类型图注入 (Layer 2)
  src/dashboard.ts                 → Agent 管理面板 Webview (Layer 3)
  src/agent-tools.ts               → 认知级语义工具 (Layer 4)
  src/lsp-reward.ts                → LSP 诊断差值奖励 (Layer 5)
  src/mediator.ts                  → 人↔IDE↔Agent 协调 (Layer 6)
  src/host.ts                      → VS Code 宿主进程管理 (启动/通信/销毁)
  src/webview/                     → React 前端 (替代现有 TUI)
    App.tsx                        → 主面板
    ChatView.tsx                   → 对话界面
    DiffView.tsx                   → 差异审查
    AgentPanel.tsx                 → 多 Agent 状态
    SettingsView.tsx               → 配置

@comdr/ui (Agent 5)                → 退化/重组
  tui/*                            → 删除 (终端 UI 不再需要)
  mcp-server.ts                    → 保留 (MCP 对外服务)
  cli.ts                           → 保留 (CLI 模式作为 fallback)
```

---

## 五、决策点：Fork vs Extension

```
┌─────────────────────────────────────────────────────────────────┐
│                     Fork 必要性分析                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 1 (Shadow Workspace) ─── 必须 Fork                        │
│  ├── 隐藏 Electron 窗口        → VS Code API 没有               │
│  ├── 独立 LSP Server 实例      → VS Code API 没有               │
│  └── 跨进程文件副本管理        → 需要修改 Electron main process │
│                                                                 │
│  Layer 2 (Structural Context) ─ 可 Extension，但 Fork 更好       │
│  ├── LSP hover/definition      → 扩展 API 可获取 (但性能差)      │
│  ├── 类型推导图                → 需要多次 LSP 调用，扩展有延迟   │
│  └── Fork 可直连 LSP 进程      → 零开销语义查询                  │
│                                                                 │
│  Layer 3 (Agent Platform) ──── Extension 可行                    │
│  ├── Webview Panel             → 标准扩展 API                   │
│  └── 自定义编辑器布局          → Fork 更灵活，Extension 受限     │
│                                                                 │
│  Layer 4 (Agent-Native Tools)── Extension 可行                   │
│  └── 工具定义                  → 不依赖内部 API                  │
│                                                                 │
│  Layer 5 (Process Reward) ──── Fork 更好                         │
│  ├── LSP 诊断批量获取          → 扩展 API 限流                   │
│  └── Analysis Bundle 哈希      → Fork 可精准控制 LSP 状态        │
│                                                                 │
│  Layer 6 (Mediator) ────────── Extension 可行                    │
│  └── 编排逻辑                  → 纯业务逻辑                      │
│                                                                 │
│  ★ 结论: Layer 1 决定了必须 Fork。没有 Shadow Workspace，        │
│    深度集成就失去了最核心的差异化能力。                            │
│                                                                 │
│  ★ 但 Fork 的代价:                                              │
│    - VS Code 每月发版 → 需持续 rebase (~2人全职)                 │
│    - 不能使用官方 Marketplace (用 OpenVSX)                       │
│    - 微软专有扩展无法运行 (Live Share, Remote Dev 等)            │
│    - 社区隔离，Bug 自己修                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 六、Fork 策略：最小化 Fork 表面积的方案

借鉴 Void editor 的做法——不是全量 fork，而是**最小化补丁集**：

```
VS Code OSS (上游)
  │
  ├── patch: extension-host-lsp-bridge      ← LSP 进程共享 (Layer 1,2)
  ├── patch: hidden-editor-window           ← Shadow Workspace (Layer 1)
  ├── patch: textmodel-diff-hook            ← Agent diff 拦截 (Layer 0)
  │
  └── 其余全部走扩展 API (Layer 3-6)

★ 只 patch 三个关键点，其余全部是扩展代码。
★ 补丁约 200-500 行（vs Cursor 的数万行），rebase 成本可控。
```

---

## 七、迁移路线（从终端优先到编辑器优先）

```
Phase 1: Extension 筑基 (4周)
  ├── packages/vscode 包创建
  ├── activate() + Webview React 面板
  ├── Engine 在 Extension Host 里跑起来
  ├── 基本对话 + diff preview
  └── 目标: 能用，但 LSP 验证靠手动

Phase 2: Fork + Shadow Workspace (6周)
  ├── VS Code OSS fork 配置
  ├── 3 个核心 patch
  ├── Shadow Workspace 实现
  ├── LSP 诊断闭环 (3轮断路器)
  └── 目标: Agent 改的代码过 LSP 后才给你看

Phase 3: 结构化上下文 + Process Reward (4周)
  ├── LSP 类型图/调用链注入 context
  ├── Analysis Bundle + 诊断差值奖励
  ├── reflection.ts 增加 LSP reward 路径
  └── 目标: Self-Correct 从 LLM 自省 → 编译器事实

Phase 4: Agent Platform + Mediator (4周)
  ├── 多 Agent 并行管理面板
  ├── Mediator 自动任务编排
  ├── Agent-Native 语义工具
  └── 目标: 人从打字者变成管理者
```

---

## 八、最关键的洞察（来自 Paper 交叉验证）

1. **LSP 是 Agent 的"编译器事实来源"**——Lanser-CLI 证明 LSP 诊断差值可以当奖励信号训练 RL。JetBrains PSI 证明注入结构化上下文 Recall@1 +20%。两个独立研究指向同一个结论：**LSP 不是"辅助功能"，是 Agent 的基础设施。**

2. **工具不该是 IDE API 的薄封装**——LSAP 的核心洞察：LSP 是为人类编辑器设计的（12 步原子操作），Agent 需要的是 1 步认知操作（12 步后台编排 + 1 份结构化报告）。

3. **Fork 是手段不是目的**——最小化补丁集（3 个 patch，~300 行）可以达到 Cursor 80% 的深度集成效果，rebase 成本可控。Void 已经证明了这条路可行。

4. **Mediator 是终极形态**——TU Delft 的论文不是讲"更好的代码补全"，而是讲 IDE 本身变成了 Agent 和人之间的翻译层。这是范式级的变化。

---

> 完整参考 Paper 列表见 README.md 或本文档关联的研究笔记。
