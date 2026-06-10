# Comdr × VS Code 集成方案

> 前两份文档的研究结论 + 取舍重审。
> 取舍标准：不适合 Comdr 才砍，不以工作量为理由砍。

---

## 〇、重审每一个取舍

```
层/能力                  保留?   理由（必须是"不适合 Comdr"，不能是"太难"）
═══════════════════════════════════════════════════════════════════════════════

Shadow Workspace (L1)    YES    完全契合 Comdr 的核心原则:
                               "编排层+执行层扛主力, LLM只做它擅长的"
                               Shadow Workspace = 确定性 LSP 验证,
                               正是"不该交给 LLM 判断"的东西。
                               ★ 这是 DeepSeek reasoning_content 级别的深度。
                               → Phase 1 做。

Structural Context (L2)  YES    +20% Recall@1 有量化证据。
                               Comdr 已有 semantic memory + world-model,
                               LSP 类型图是自然升级。
                               → Phase 1 做。

LSP Self-Correct (L5)    YES    Comdr 已有 reflection.ts + selfCorrect()。
                               LSP 诊断差值是比 LLM 自省更可靠的纠正信号。
                               和现有架构完美对接。
                               → Phase 1 做。

Agent-Native Tools (L4)  YES    LSAP: "1 次认知操作 = 12 步后台编排"。
                               契合 Comdr 的拓扑并行调度(scheduler.ts)。
                               → Phase 2 做。

Agent Dashboard (L3)     YES    Comdr 已有 subagent.ts (fanOut/runSubAgent/pipeline)。
                               面板只是让已有能力可视化。
                               → Phase 2 做。

Shadow Workspace 提前到
Phase 1 的理由           重新评估 之前把它放 Phase 3 是因为"需要 fork"。
                               但 fork 的成本应该被 workaround 消解（最小化补丁集），
                               而不是用来推迟核心能力。
                               用户一开始就说了"放弃终端, 选路线B"。
                               → Phase 1 就做 Fork + Shadow Workspace。

全量 VS Code Fork        砍掉   不适合。Comdr 的护城河是 Agent 循环 + DeepSeek 集成,
                               不是"造一个新 IDE"。Cursor 级全量 fork(数万行补丁)
                               会让 Comdr 变成"维护 fork"而不是"做 agent 创新"。
                               3-patch 最小化 fork(～240行) 就够了。

RL 训练管线              砍掉   不适合。Comdr 是 coding agent, 不是 AI 训练平台。
                               RL 需要 GPU 集群、数据管线、评估框架——
                               和 Comdr 完全不同的基础设施。
                               LSP 奖励信号保留(用于 self-correct),
                               RL 训练砍掉。

Mediator 独立模块        融入   不适合做独立抽象。Comdr 已有 planner.ts 做任务路由。
                               TU Delft 的 mediator 概念(统一人↔IDE↔Agent 接口)
                               融入 planner, 不做新的抽象层。

多 IDE 支持              设计预留 不适合 Phase 1。但架构上把 IDE 接口分离
                                (参考 Continue.dev 的 IDE interface),
                                实现只做 VS Code。

CLI 模式                 保留   适合。CI/headless/SSH 必须用 CLI。
                               VS Code 变主交互面, CLI 退居二线, 不删除。

MoonBit ACI 六柱全部      部分   3/6 已在 SDB 管线。语言层面的柱子
                               (flattened syntax, manifest types) 需要语言设计配合,
                               不适用于处理现有语言的 coding agent。
```

---

## 一、最终方案：两阶段

```
Phase 1 (6周): Fork + 核心差异化
  ├── 最小化 VS Code fork (3 patches, ~240行)
  ├── Shadow Workspace (Agent 改代码 → 隐藏窗口 → LSP → 修正 → 呈现)
  ├── Structural Context (LSP 类型图/调用链 → prompt 注入)
  ├── LSP Self-Correct (诊断差值 → reflection.ts 纠正信号)
  └── 基础 Webview (对话 + diff preview + accept/reject)

Phase 2 (4周): 体验层
  ├── Agent-Native 认知工具 (composed LSP operations)
  ├── 多 Agent 管理面板 (subagent 可视化)
  └── Mediator 概念融入 planner
```

---

## 二、Phase 1 架构

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         Comdr VS Code (Fork 基础)                             ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │  VS Code 窗口 (用户可见)                                              │    ║
║  │                                                                        │    ║
║  │  ┌─────────────────────────┐  ┌────────────────────────────────────┐  │    ║
║  │  │ 文件编辑器 (正常使用)     │  │ Comdr Panel (Webview)              │  │    ║
║  │  │                         │  │                                    │  │    ║
║  │  │ src/auth.ts             │  │  Chat ─── 对话 + Agent 思考过程    │  │    ║
║  │  │ (用户正常编辑)           │  │  Diff ─── Agent 修改, 过审后呈现   │  │    ║
║  │  │                         │  │  Log ─── 工具调用 + 诊断反馈       │  │    ║
║  │  │ LSP 诊断 (用户侧)        │  │                                    │  │    ║
║  │  │ → 红线 = 用户自己的错    │  │ [Accept] [Reject] [Edit]          │  │    ║
║  │  └─────────────────────────┘  └────────────────────────────────────┘  │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │  Shadow 隐藏窗口 (用户不可见)                      ★ Patch 1 实现     │    ║
║  │                                                                        │    ║
║  │  ┌─────────────────────────────────────────────────────────────────┐ │    ║
║  │  │ src/auth.ts (copy) + Agent 的修改                                │ │    ║
║  │  │ LSP Server (独立实例) → 诊断 → 3 轮自动修复 → 断路器             │ │    ║
║  │  │                                                                  │ │    ║
║  │  │ 修复结果:                                                         │ │    ║
║  │  │   ✅ 无新错误 → diff 合并到用户窗口, 用户审核                      │ │    ║
║  │  │   ❌ 3轮未修复 → 放弃, 呈现原始 diff + LSP 错误列表给用户          │ │    ║
║  │  └─────────────────────────────────────────────────────────────────┘ │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │  Extension Host (Node.js)                                             │    ║
║  │                                                                        │    ║
║  │  ┌──────────────────────────┐  ┌───────────────────────────────────┐ │    ║
║  │  │ @comdr/vscode (NEW)       │  │ @comdr/engine (改造 3 文件)        │ │    ║
║  │  │                          │  │                                   │ │    ║
║  │  │ extension.ts             │  │ loop.ts ─── 9步主循环 (不变!)     │ │    ║
║  │  │   activate():            │  │ prompt.ts ─ +LSP 类型上下文       │ │    ║
║  │  │   1. new Engine()        │  │ reflection.ts +LSP 诊断纠正       │ │    ║
║  │  │   2. 连接 Shadow Window  │  │ world-model.ts +LSP 语义管道      │ │    ║
║  │  │   3. 注册 VS Code 工具   │  │                                   │ │    ║
║  │  │   4. Webview 双向通信    │  │ 其余子系统全部不变:               │ │    ║
║  │  │                          │  │   planner / context / reasoning   │ │    ║
║  │  │ lsp-bridge.ts            │  │   memory(4) / progress / skills   │ │    ║
║  │  │   getDiagnostics()       │  │   scheduler / subagent / mcp      │ │    ║
║  │  │   getTypeGraph()         │  │                                   │ │    ║
║  │  │   getCallHierarchy()     │  └───────────────────────────────────┘ │    ║
║  │  │                          │                                        │    ║
║  │  │ shadow-workspace.ts      │  ┌───────────────────────────────────┐ │    ║
║  │  │   applyEdit()            │  │ @comdr/llm (完全不变)              │ │    ║
║  │  │   validate()             │  │ DeepSeek client + reasoning +      │ │    ║
║  │  │   mergeToUser()          │  │ prefix cache                       │ │    ║
║  │  │                          │  └───────────────────────────────────┘ │    ║
║  │  │ vscode-tools.ts          │                                        │    ║
║  │  │   VS Code 原生能力       │  ┌───────────────────────────────────┐ │    ║
║  │  │   → Agent 工具接口       │  │ comdr-tools/Rust (不变)            │ │    ║
║  │  └──────────────────────────┘  │ SDB 6步 + file/git/shell/lsp      │ │    ║
║  │                                └───────────────────────────────────┘ │    ║
║  │                                                                        │    ║
║  │  ┌──────────────────────────────────────────────────────────────────┐ │    ║
║  │  │ 数据流 (Shadow Workspace 闭环):                                   │ │    ║
║  │  │                                                                  │ │    ║
║  │  │ Agent tool_call(file_edit)                                        │ │    ║
║  │  │   │                                                              │ │    ║
║  │  │   ▼                                                              │ │    ║
║  │  │ shadow-workspace.applyEdit() ──→ 写入隐藏窗口的文件副本           │ │    ║
║  │  │   │                                                              │ │    ║
║  │  │   ▼                                                              │ │    ║
║  │  │ LSP 诊断 (隐藏窗口的独立 LSP 实例, Patch 1)                       │ │    ║
║  │  │   │                                                              │ │    ║
║  │  │   ├── 无新错误 → ✅ mergeToUser() → 用户窗口呈现 diff             │ │    ║
║  │  │   │                                                              │ │    ║
║  │  │   └── 有新错误 → Agent 尝试修复 (LSP 诊断作为上下文)               │ │    ║
║  │  │       │                                                          │ │    ║
║  │  │       ├── 修复成功 → mergeToUser()                                │ │    ║
║  │  │       └── 3轮失败 → mergeToUser() + 附加 LSP 错误列表             │ │    ║
║  │  │                        用户看到 diff + 标注"有 N 个错误未修复"    │ │    ║
║  │  └──────────────────────────────────────────────────────────────────┘ │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
║  ┌──────────────────────────────────────────────────────────────────────┐    ║
║  │  3 个 Fork Patch (最小化, ～240 行)                                   │    ║
║  │                                                                        │    ║
║  │  Patch 1: hidden-editor-window (~100 行)                              │    ║
║  │   文件: src/vs/workbench/contrib/comdr/ (新建)                         │    ║
║  │   作用: Electron BrowserWindow(show:false) → 独立 LSP                  │    ║
║  │                                                                        │    ║
║  │  Patch 2: lsp-bridge-ipc (~80 行)                                     │    ║
║  │   文件: src/vs/workbench/api/common/extHostLanguageFeatures.ts         │    ║
║  │   作用: LSP 诊断流暴露给 Extension Host (bypass 扩展 API 限流)         │    ║
║  │                                                                        │    ║
║  │  Patch 3: textmodel-write-hook (~60 行)                               │    ║
║  │   文件: src/vs/editor/common/model/textModel.ts                        │    ║
║  │   作用: Agent 写入拦截 → 路由到 Shadow Workspace                       │    ║
║  └──────────────────────────────────────────────────────────────────────┘    ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## 三、和现有 Comdr 模块的具体对接

### 3.1 prompt.ts 改动（+LSP 类型上下文，~60 行）

```typescript
// 当前 7 层 prompt 结构:
//   L0: COMDR.md 项目指令
//   L1: World Model 多源分块
//   L2: Repository Map (Aider式)
//   L3: Entity Context (Semantic Memory 子图)
//   L4.5: State-Enriched Graph RAG
//   L5: Compact Summary (上下文压缩摘要)
//   L6: Cross-session Episodic Retrieval
//
// ★ 新增 L1.5: LSP Structural Context
//   位置: L1 (World Model) 和 L2 (Repo Map) 之间
//   理由: 比 Repo Map 更精确（类型级），比 World Model 更实时

setLSPContext(ctx: LSPFileContext): void {
  // LSPFileContext {
  //   file: string;
  //   exports: SymbolInfo[];     // name + type + signature
  //   imports: ImportInfo[];     // name + from + usedWhere
  //   callers: CallerInfo[];     // file:line + symbol
  //   callees: CalleeInfo[];     // symbol + file
  //   typeGraph: TypeEdge[];     // extends/implements/union members
  //   diagnostics: Diagnostic[]; // current errors/warnings/hints
  // }
  //
  // 输出格式: Markdown 表格，注入 Static Zone
  // 缓存: 文件内容不变 → LSP 类型图不变 → 前缀缓存可复用
}

// 触发: Agent 的 tool_call 涉及某文件 → lsp-bridge.ts 查询 LSP 上下文
//       → setLSPContext() → prompt.build() 自动包含
```

### 3.2 reflection.ts 改动（+LSP 诊断纠正，~50 行）

```typescript
// 当前 selfCorrect 流程:
//   SDB Step 6 test failed → reasoning_content 回注 → Chat Prefix Completion 纠正
//
// ★ 新增并行纠正路径: LSP 诊断差值
//   两者互补, 不是替代:
//     LSP 路径: 处理语法/类型错误 (确定性, 不需要 LLM)
//     DeepSeek 路径: 处理逻辑/测试错误 (需要 LLM 理解)
//
//   流程:
//     tool 执行前: 记录文件 LSP 诊断 D_before
//     tool 执行后: 记录文件 LSP 诊断 D_after
//     newErrors = D_after \ D_before     (Agent 引入的新错误)
//     fixedErrors = D_before \ D_after   (Agent 修复的错误)
//
//     if newErrors.length === 0:
//       → ✅ 接受修改
//     elif fixedErrors.length > 0 && newErrors.length <= fixedErrors.length:
//       → ⚠️ 整体改善, 但有新错误 → 把 newErrors 注入为 Agent 上下文, 让它再修
//     else:
//       → ❌ 纯引入新错误 → snapshot rollback + 通知用户

async correctByLSP(
  filePath: string,
  diagBefore: Diagnostic[],
  diagAfter: Diagnostic[],
): Promise<{ accepted: boolean; feedback: string }> {
  // ★ 确定性的——不调 LLM, 纯 diff 计算
}
```

### 3.3 world-model.ts 改动（+LSP 语义管道，~40 行）

```typescript
// 当前: COMDR.md + 多源分块检索（纯文本）
//
// ★ 新增: LSP 语义管道
//   bootstrap (Rust): 全项目广度扫描 (符号列表 + 文件引用)
//   LSP 语义管道:     当前任务深度分析 (类型图 + 调用链)
//
//   两者互补: bootstrap 给"项目有什么", LSP 给"当前文件怎么关联"

async buildLSPSemanticChunk(
  currentFile: string,
  lspBridge: LSPBridge,
): Promise<LSPSemanticChunk | null> {
  // 1. getCallHierarchy → 谁调用了我, 我调用了谁
  // 2. getTypeHierarchy → 我继承/实现了什么
  // 3. getReferences → 我的符号在哪里被引用
  //
  // 返回: Markdown, 可缓存 (代码不变则语义关系不变)
}
```

---

## 四、改了什么、没改什么（一张表）

```
模块                  改?  行数   说明
═══════════════════════════════════════════════════════════════════════════
@comdr/core/types.ts  改   +20   新增 LSPDiagnostic, LSPFileContext 等类型
@comdr/core/contracts 改   +15   新增 Contract F: IVSCodeHost
@comdr/llm/*          不变 0      DeepSeek 集成已成熟
comdr-tools (Rust)    改   +30   sdb.rs 预留 Step 7 LSP Validate 钩子
@comdr/engine/loop    不变 0      9 步主循环不变
@comdr/engine/prompt  改   +60   +LSP 类型上下文注入层
@comdr/engine/reflection 改 +50   +LSP 诊断差值纠正路径
@comdr/engine/world-model 改 +40 +LSP 语义管道
@comdr/engine/memory/* 不变 0    四记忆系统不变
@comdr/engine/planner  不变 0    路由逻辑不变
@comdr/engine/context  不变 0    压缩逻辑不变
@comdr/engine/reasoning 不变 0   thinking 管理不变
@comdr/engine/subagent 不变 0   子 Agent 不变
@comdr/ui/tui          不变 0   保留 CLI 模式
@comdr/ui/cli          不变 0   保留 CLI 入口
@comdr/vscode (NEW)    新增 ~800 整个新包

3 个 Fork Patch        新增 ~240  VS Code OSS 最小化改动
```

---

## 五、Phase 2 做什么

Phase 1 交付后，在已有 Shadow Workspace + LSP 闭环的基础上：

```
Phase 2 (4周):

1. Agent-Native 认知工具 (LSAP pattern)
   现有工具: file_read + file_grep + symbol_find (3次调用)
   认知工具: understand_file → 1次调用 → LSP编排 → Markdown报告
   实现: @comdr/vscode/src/agent-tools.ts
         后台编排 getDefinition + getHover + getReferences + getCallHierarchy
         一次返回完整语义上下文

2. 多 Agent 管理面板
   现有: subagent.ts (fanOut/runSubAgent/pipeline), 但不可见
   新增: Webview AgentPanel → 每个 subagent 的状态/进度/diff 可视化
   实现: @comdr/vscode/src/webview/AgentPanel.tsx

3. Mediator 概念融入 planner
   现有: planner.route() 按关键词路由 (6 模式)
   增强: route() 自动判断"这个任务该调 IDE 的哪个功能 + Agent 的哪个能力"
         例: "修复类型错误" → IDE LSP诊断 + Agent 代码生成
              "重构模块"   → IDE 重构引擎 + Agent 生成新实现
```

---

## 六、Phase 1 开发顺序

```
Week 1: Fork 基础
  □ VS Code OSS clone + build 环境
  □ 3 个 patch 实现 + 验证
  □ CI/CD: 自动 rebase 检测

Week 2-3: Shadow Workspace
  □ hidden-editor-window 创建/销毁
  □ 独立 LSP 实例连接
  □ applyEdit → LSP 诊断 → 断路器 (3 轮)
  □ mergeToUser: 验证通过 → 用户窗口呈现

Week 3-4: LSP Context Bridge
  □ lsp-bridge.ts: getDiagnostics/getTypeGraph/getCallHierarchy
  □ prompt.ts 改造: LSP 类型上下文注入
  □ 缓存: 文件内容不变 → LSP 上下文不变

Week 4-5: LSP Self-Correct + World Model
  □ reflection.ts 改造: LSP 诊断差值纠正路径
  □ world-model.ts 改造: LSP 语义管道
  □ SDB 预留 Step 7 LSP Validate 钩子

Week 5-6: Webview + 集成
  □ Webview React 框架 (ChatView + DiffPreview)
  □ Extension Host → Webview 双向通信
  □ vscode-tools.ts: VS Code 能力 → Agent 工具接口
  □ 端到端测试: 一个完整的 "改代码 → LSP 验证 → 呈现 diff" 流程
```

---

## 七、不做的事情（有理由的砍掉）

| 砍掉 | 不是"太难"，而是 "不适合 Comdr" |
|------|-------------------------------|
| **全量 VS Code Fork** | Comdr 不是要造新 IDE。Cursor 级数万行补丁会让项目变成"维护 fork 的公司"。3-patch 最小化 fork 足以打通 Shadow Workspace 数据流。 |
| **RL 训练管线** | Comdr 是 coding agent，不是 AI 训练平台。保留 LSP 奖励信号用于 self-correct，砍掉离线 RL 训练——那需要 GPU 集群和数据管线，是完全不同的系统。 |
| **Mediator 独立模块** | 不适合做独立抽象层。TU Delft 的 mediator 概念有价值，但 Comdr 已有 planner.ts——融入比重写更合适。 |
| **MoonBit ACI 全部六柱** | 3/6 已在 SDB。语言层面的柱子（flattened syntax）是给新语言设计的，Comdr 处理的是现有语言。 |
| **多 IDE 支持** | 不适合 Phase 1。架构上预留 IDE interface 分离（参考 Continue.dev），但实现只做 VS Code。 |
