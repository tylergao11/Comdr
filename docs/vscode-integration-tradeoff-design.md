# Comdr × VS Code 集成取舍设计

> 基于 [vscode-deep-integration-architecture.md](./vscode-deep-integration-architecture.md) 的研究结论，
> 结合 Comdr 项目实际情况（团队规模、现有优势、维护成本）做的取舍决策。

---

## 〇、核心取舍原则

### 原则 1：DeepSeek 级别的"深度"不是每层都要

DeepSeek 深度适配的核心是**利用平台独有特性，不用通用抽象层**。对 VS Code，这意味着：

```
DeepSeek 适配: 不用 OpenAI 兼容 API → 直接用 reasoning_content + thinking + prefix
VS Code 适配:  不用 LSP 通用客户端 → 直接用 VS Code 内部的 TextModel + Extension Host
```

但 VS Code 的"独有特性"暴露面远大于 DeepSeek API。DeepSeek 是一个 HTTP endpoint，VS Code 是一个完整的 Electron 应用。**全部深度集成 = 维护一个 VS Code fork = 不现实。**

### 原则 2：按证据强度排序，不按理论完美度排序

| 证据等级 | 设计 | 来源 | Comdr 行动 |
|---------|------|------|-----------|
| **强证据（量化）** | 结构化上下文 → Recall@1 +20% | JetBrains PSI | **Phase 1 做** |
| **强证据（量化）** | LSP 诊断差值 → 奖励信号 | Lanser-CLI | **Phase 1 做** |
| **中等证据（系统）** | Agent-Native 认知工具 | LSAP | **Phase 2 做** |
| **中等证据（系统）** | Shadow Workspace | Cursor（工业界） | **Phase 3 做（需 fork）** |
| **概念框架** | Mediator Agent | TU Delft | **作为北极星，不做实现** |
| **愿景论文** | IDE = Agent 管理平台 | Marron | **Phase 2 部分做** |
| **语言设计** | ACI 六柱 | MoonBit | **已有 SDB 即覆盖 80%** |

### 原则 3：Extension First, Fork Later

- Phase 1-2 全部走 VS Code Extension API
- 架构上预留 fork 接口，但代码不依赖 fork
- 只有当 Extension API 被证伪（某个关键功能确实做不到）时才 fork
- Fork 策略：3 个最小化 patch，不是全量 fork

---

## 一、七层取舍矩阵

```
层      名称                  Phase 1  Phase 2  Phase 3  砍掉      理由
═══════════════════════════════════════════════════════════════════════════════════
L6  Mediator Agent            ░░░░░    ░░░░░    部分     核心逻辑  概念框架，北极星。
                                                          不做独立模块，融入 planner。

L5  Process Reward (LSP)      █████    █████    █████   —        最强证据。改造 reflection.ts
                                                          LSP 诊断差值替代 LLM 自省。

L4  Agent-Native Semantics    ░░░░░    █████    █████   —        中等证据。重构工具层，
                                                          从"薄封装"变"认知操作"。

L3  Agent Platform (面板)      ░░░░░    █████    █████   —        愿景。多 Agent 可视化管理。
                                                          扩展 API 可做，不需 fork。

L2  Structural Context         █████    █████    █████   —        ★ 最高 ROI。+20% Recall@1。
                                                          JetBrains PSI 有数据支撑。

L1  Shadow Workspace           ░░░░░    ░░░░░    █████   —        最高成本。必须 fork。
                                                          但也是最大差异化。

L0  ACI Primitives             ████░    █████    █████   —        已有 SDB 管线。补齐
                                                          LSP 诊断的确定性哈希即可。
```

- █████ = 全力实现
- ████░ = 部分实现
- ░░░░░ = 设计预留，代码不做

---

## 二、Phase 1 设计（目标：4 周，Extension 可用）

### 2.1 Phase 1 做什么

```
目标: VS Code 扩展能跑起来，Agent 能对话能改代码。
差异化: LSP 结构化上下文注入 + LSP 诊断驱动的 self-correct。
不做的: Shadow Workspace、Agent 管理面板、认知工具重构。
```

### 2.2 Phase 1 架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                     VS Code 窗口                                     │
│  ┌──────────────────────────┬────────────────────────────────────┐  │
│  │ 文件编辑器 (正常使用)      │  Comdr Panel (Webview React)       │  │
│  │                          │                                    │  │
│  │  src/auth.ts             │  ┌──────────────────────────────┐  │  │
│  │  (用户正常编辑)           │  │ Chat: 对话 + diff preview     │  │  │
│  │                          │  │ Agent 状态: 当前工具/进度    │  │  │
│  │  LSP 诊断 (共享)          │  │ 一键 Accept/Reject diff     │  │  │
│  │  → 用户看到红色波浪线     │  └──────────────────────────────┘  │  │
│  └──────────────────────────┴────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Extension Host (Node.js)                                      │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ @comdr/vscode        │  │ @comdr/engine (不变!)         │   │  │
│  │  │ src/extension.ts    │  │ loop.ts → 完整 9 步主循环     │   │  │
│  │  │                     │  │                                │   │  │
│  │  │ activate():         │  │ prompt.ts → +LSP 类型层       │   │  │
│  │  │  1. new Engine()    │  │ reflection.ts → +LSP 诊断奖励 │   │  │
│  │  │  2. Webview 双向通信│  │ world-model.ts → +LSP 语义管道│   │  │
│  │  │  3. VS Code 工具适配│  │                                │   │  │
│  │  └─────────────────────┘  └──────────────────────────────┘   │  │
│  │                                                                │  │
│  │  ┌─────────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ LSP Context Bridge   │  │ @comdr/llm (不变!)            │   │  │
│  │  │ - getDiagnostics()   │  │ client.ts → DeepSeek API     │   │  │
│  │  │ - getHover()         │  │ reasoning 管理               │   │  │
│  │  │ - getReferences()    │  └──────────────────────────────┘   │  │
│  │  │ - getCallHierarchy() │                                      │  │
│  │  └─────────────────────┘  ┌──────────────────────────────┐   │  │
│  │                           │ comdr-tools (Rust, 不变)       │   │  │
│  │                           │ SDB 6步 + file/git/shell      │   │  │
│  │                           └──────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

关键: @comdr/engine, @comdr/llm, comdr-tools 三个核心包不变。
      只新增 @comdr/vscode 适配层 + 改造 engine 的三个子系统。
```

### 2.3 改动范围（最小化）

```
新增:
  packages/vscode/                     ★ 新包
    src/extension.ts                   activate/deactivate
    src/webview/                        React 前端
      App.tsx
      ChatView.tsx
      DiffPreview.tsx
    src/lsp-bridge.ts                  LSP 诊断/类型查询桥接
    src/vscode-tools.ts                VS Code 原生能力 → Agent 工具

改造（只动 3 个文件，每个改 ~50 行）:
  packages/engine/src/prompt.ts        + LSP 结构化上下文注入层
  packages/engine/src/reflection.ts    + LSP 诊断差值纠正路径
  packages/engine/src/world-model.ts   + LSP 语义管道

不变（核心资产保护）:
  packages/core/*                      类型+契约层
  packages/llm/*                       DeepSeek 客户端
  packages/engine/src/loop.ts          主循环（9步不变）
  packages/engine/src/memory/*         四记忆系统
  packages/engine/src/planner.ts       路由
  packages/engine/src/context.ts       压缩
  packages/engine/src/reasoning.ts     推理管理
  crates/comdr-tools/*                 Rust 执行层
```

### 2.4 三个改造的细节

#### 2.4.1 prompt.ts：+LSP 结构化上下文注入层

```typescript
// 当前: prompt.ts 7层构造中，上下文是纯文本
// 改造: LSP 类型信息作为独立的 "类型层" 注入

// prompt.ts 新增方法:
setLSPContext(ctx: LSPFileContext): void {
  // LSPFileContext = {
  //   file: 'src/auth/login.ts',
  //   exports: ['LoginHandler', 'validateSession'],
  //   imports: [{ name: 'jwt.verify', from: 'jsonwebtoken' }],
  //   callers: ['src/routes/auth.ts:42', 'src/middleware/auth.ts:15'],
  //   typeDeps: ['UserSession', 'AuthToken'],
  //   diagnostics: [{ line: 23, severity: 'error', message: '...' }]
  // }
  //
  // 格式化为 Agent 友好的 Markdown 表格，注入到 Static Zone
  // （同一文件类型信息不变 → 前缀缓存友好）
}

// 触发时机: Agent 的 tool_call 涉及某文件 → 自动查询该文件的 LSP 上下文
// 替代: 当前 World Model 的纯文本文件列表
```

**证据来源**: JetBrains PSI 论文 — 结构化上下文让 Recall@1 提升 20%。

#### 2.4.2 reflection.ts：+LSP 诊断差值纠正路径

```typescript
// 当前: selfCorrect() 依赖 reasoning_content + Chat Prefix Completion
// 改造: 增加 LSP 诊断差值作为第二纠正信号

// reflection.ts 新增:
async correctByLSP(
  call: ToolCall,
  filePath: string,
  diagnosticsBefore: LSPDiagnostic[],
  diagnosticsAfter: LSPDiagnostic[],
): Promise<CorrectionResult> {
  // 1. 计算诊断差值
  const newErrors = diffDiagnostics(diagnosticsBefore, diagnosticsAfter);

  // 2. 如果 Agent 引入了新错误 → 标记为失败
  if (newErrors.length > 0) {
    return {
      corrected: false,
      explanation: `Introduced ${newErrors.length} new errors:\n` +
        newErrors.map(e => `  L${e.line}: ${e.message}`).join('\n'),
    };
  }

  // 3. 如果 Agent 修复了错误 → 标记为成功
  const fixedErrors = diffDiagnostics(diagnosticsAfter, diagnosticsBefore);
  if (fixedErrors.length > 0) {
    return { corrected: true, explanation: `Fixed ${fixedErrors.length} errors` };
  }

  // 4. 否则走原有的 LLM self-correct 路径
  return this.selfCorrect(call, result, reasoningContent);
}

// ★ 关键: LSP 诊断是确定性事实，不是 LLM 的"猜测"。
//   新错误引入 = 回滚。错误修复 = 接受。模糊情况 = 走 LLM。
```

**证据来源**: Lanser-CLI 论文 — LSP 诊断差值作为过程奖励信号。

#### 2.4.3 world-model.ts：+LSP 语义管道

```typescript
// 当前: World Model 多源分块检索（COMDR.md + 项目文件列表 + 符号索引）
// 改造: 增加 LSP 语义管道，替代纯文本正则匹配

// world-model.ts 新增:
async buildLSPWorldModel(
  projectPath: string,
  currentFile: string,
): Promise<LSPSemanticChunk[]> {
  // 通过 VS Code LSP API:
  //   1. getCallHierarchy(currentFile)  → 谁调用了当前文件的符号
  //   2. getReferences(currentSymbol)   → 当前符号被哪里引用
  //   3. getTypeHierarchy(currentClass) → 当前类的继承/实现链
  //
  // 返回: 语义相关的文件/符号列表（精确到行号）
  // 格式: Markdown，可缓存（代码不改则语义关系不变）
}

// ★ 和现有 bootstrap (Rust 正则扫描) 的关系:
//   bootstrap 做广度（全项目符号列表），LSP 做深度（精确语义关系）
//   两者互补，不替代
```

**证据来源**: JetBrains PSI 论文 + 现有 bootstrap.rs。

---

## 三、Phase 2 设计（目标：Extension 完善，+4 周）

### 3.1 Phase 2 做什么

```
目标: 认知工具重构 + Agent 管理面板。
差异化: Agent-Native 语义工具（1步操作 = 后台编排多个 LSP 调用）。
不做的: Shadow Workspace（仍不需 fork）。
```

### 3.2 Agent-Native 工具重构

当前 Comdr 工具层是"文件系统 + shell"的薄封装。Phase 2 增加**认知级语义工具**：

```
薄封装 (Phase 1)                →  认知工具 (Phase 2)
────────────────────────────────────────────────────────────
file_read(path)                 →  understand_file(path)
                                   返回: AST结构 + 类型信息 +
                                        调用者列表 + 相关测试 +
                                        LSP诊断 + 最近修改记录

file_grep(pattern)              →  find_usages(symbol)
                                   返回: 所有引用位置 +
                                        每个位置的上下文

symbol_find(name)              →  trace_symbol(name)
                                   返回: 定义链 + 类型层级 +
                                        实现者列表

shell_bash("npm test")         →  verify_changes()
                                   自动: 识别受影响测试 +
                                        只跑相关测试 +
                                        解析输出为结构化报告
```

**证据来源**: LSAP 论文 — Agent 不应该用 12 步原子操作，应该用 1 步认知操作。

### 3.3 Agent 管理面板

Marron 2024 的"IDE = Agent 管理平台"在 Phase 2 部分实现：

```
Comdr Panel (Webview) 布局进化:

Phase 1:                    Phase 2:
┌──────────────────────┐    ┌──────────┬──────────────────────┐
│ Chat                 │    │ Agents   │ Chat + Diff          │
│                      │    │          │                      │
│ [User] 重构 auth     │    │ ▸ main   │ [main] 完成重构      │
│ [Agent] 分析中...    │    │  重构中  │ 请审核以下变更:      │
│                      │    │          │                      │
│                      │    │ ▸ review │ ┌──────────────────┐ │
│                      │    │  等待中  │ │ src/auth.ts diff │ │
│                      │    │          │ │ [Accept][Reject] │ │
│                      │    │ ▸ test   │ └──────────────────┘ │
│                      │    │  空闲    │                      │
│                      │    │          │ [User] 方案A看起来好 │
└──────────────────────┘    └──────────┴──────────────────────┘

新增功能:
- 多 Agent 并行可见（利用现有 fanOut/subagent）
- 每个 Agent 显示: 状态/当前任务/进度/消耗 token
- Diff 审批流: Agent 请求 → 用户审核 → 接受/拒绝/编辑
- 一键回滚: 拒绝的 diff → rollback to snapshot
```

---

## 四、Phase 3 设计（目标：Fork，+6 周，触发条件）

### 4.1 什么时候才 Fork

```
触发条件 (满足任一条即进入 Phase 3):
  □ Phase 1-2 完成后，LSP 诊断反馈延迟 > 2s（扩展 API 跨进程通信瓶颈）
  □ 用户反馈 "Agent 修改的代码经常引入新错误，我需要手动检查"
  □ Comdr 有 100+ DAU 且留存率稳定 → Fork 维护成本可以被分摊
  □ 竞品（Cursor/Windsurf）的 Shadow Workspace 成为用户流失原因

如果以上都不满足:
  → 停留在 Phase 2，不 Fork。
  → Phase 2 的 LSP 诊断 + self-correct 已经覆盖 80% 的价值。
```

### 4.2 Fork 策略：3 个最小化 Patch

```
VS Code OSS (上游, 每月 rebase)
  │
  ├── Patch 1: hidden-editor-window (~100 行)
  │   文件: src/vs/workbench/contrib/void/ (fork Void 的实现)
  │   作用: 创建 show:false 的编辑器窗口 → 独立 LSP 实例
  │
  ├── Patch 2: lsp-bridge-ipc (~80 行)
  │   文件: src/vs/workbench/api/common/extHostLanguageFeatures.ts
  │   作用: 暴露 LSP 原始诊断流给 Extension Host (不经过扩展 API 限流)
  │
  └── Patch 3: textmodel-write-hook (~60 行)
      文件: src/vs/editor/common/model/textModel.ts
      作用: Agent 写入文件 → 拦截 → Shadow Workspace 先跑 LSP → 再合并到用户窗口

总计: ~240 行 patch，维护成本可控。
      对比: Cursor 的补丁量是数万行。

Rebase 策略:
  - 每月 VS Code 发版后 1 周内 rebase
  - 3 个 patch 都是独立功能点，冲突概率低
  - 自动化 CI: 检测 patch 是否 clean apply → 告警
```

---

## 五、不做的事情（明确砍掉）

| 砍掉 | 理由 |
|------|------|
| **全量 VS Code Fork** | Cursor 级别 fork 需要 2+ 人全职 rebase。等 Comdr 有 100+ DAU 再说。 |
| **RL 训练管线** | Lanser-CLI 的完整 RL 流程。Comdr 不是 AI 公司，没有训练基础设施。保留 LSP 奖励信号用于 self-correct 即可。 |
| **Mediator 独立模块** | TU Delft 的完整 Mediator Agent。概念层面融入 planner.ts，不做独立的 mediator 抽象。 |
| **MoonBit ACI 全部六柱** | 语言设计层面的改进。SDB 已覆盖确定性 diff + 沙箱编译 + 机器可读诊断。语法/类型柱需要语言级支持。 |
| **多 IDE 支持** | Continue.dev 式的跨 IDE 可移植架构。先吃透 VS Code，再做 JetBrains。 |
| **删除终端模式** | CLI 模式保留，用于 CI/headless/remote/SSH。它不是"被取代"，是"退居二线"。 |

---

## 六、和现有 Comdr 架构的集成点

```
@comdr/core (Agent 1)
  types.ts: 新增 LSPDiagnostic, LSPFileContext, EditorState 等类型
  contracts.ts: 新增 Contract F: IVSCodeHost (VS Code 宿主能力契约)
  ★ 仍然是类型唯一真理源

@comdr/llm (Agent 2)
  ★ 完全不变。DeepSeek 集成已成熟。

comdr-tools (Agent 3, Rust)
  sdb.rs: Step 7 (NEW) — LSP Validate (Phase 3 启用)
  bootstrap.rs: 增强 — LSP 语义扫描（Phase 2）
  ★ Rust 层只加不改。

@comdr/engine (Agent 4)
  prompt.ts: +LSP 类型上下文层（Phase 1）
  reflection.ts: +LSP 诊断纠正路径（Phase 1）
  world-model.ts: +LSP 语义管道（Phase 1）
  tools/advanced-tools.ts: +认知工具（Phase 2）
  loop.ts: ★ 不动的核心——9 步主循环不变
  ★ 三个文件各改 ~50 行，引擎核心逻辑不受影响。

@comdr/vscode (Agent 6, NEW)
  extension.ts: 激活入口
  lsp-bridge.ts: LSP 桥接
  vscode-tools.ts: VS Code 原生能力适配
  webview/: React 前端
  ★ 纯新增包，不碰现有包。

@comdr/ui (Agent 5)
  tui/*: 保留但降级（CLI fallback 模式）
  mcp-server.ts: 保留（MCP 对外服务）
  ★ 不删代码，只降优先级。
```

---

## 七、Phase 1 关键设计决策

### 决策 1：Engine 运行在 Extension Host 里

```
选择: Engine 实例直接在 Extension Host 的 Node.js 进程中运行
不选: Engine 跑在独立进程，通过 IPC 通信

理由:
  - Extension Host 已经是独立进程（VS Code 帮你隔离好了）
  - 再加一层进程 = 增加延迟，每轮 Agent 循环多 ~50ms IPC 开销
  - Node.js 的 napi-rs 在 Extension Host 里无缝运行
  - 崩溃隔离: Extension Host 崩溃 → VS Code 自动重启，不影响用户编辑
  - DeepSeek API 调用是网络 IO，不占用 VS Code 主线程
```

### 决策 2：Webview 通信用 postMessage，不用 WebSocket

```
选择: VS Code Webview API (postMessage + onDidReceiveMessage)
不选: WebSocket 或 HTTP 本地服务器

理由:
  - Webview API 是 VS Code 标准做法，无需额外端口管理
  - 强类型消息（ExtensionMessage / WebviewMessage 接口）
  - VS Code 自动管理 Webview 生命周期
  - 安全: 内容安全策略(CSP)由 VS Code 管理
```

### 决策 3：LSP 信息通过 VS Code API 获取，不直连 LSP Server

```
Phase 1 选择: vscode.languages.getDiagnostics() + executeHoverProvider() 等
Phase 3 可选: 直连 LSP Server 进程（需 Patch 2）

理由 (Phase 1):
  - VS Code 扩展 API 已经暴露了 LSP 的核心能力
  - 直连 LSP Server 需要理解每个语言的 LSP 实现细节
  - 扩展 API 延迟在 ~50ms 内，对 Agent 循环（秒级）可忽略
  - 先验证"结构化上下文有价值"这个假设，再投入 fork

风险:
  - vscode.languages.getDiagnostics() 只返回当前已报告诊断
  - 对未打开的文件的 LSP 信息获取有限
  - Phase 1 的局限: 只对用户已打开/最近打开的文件有完整 LSP 上下文
  - ★ 这是 Phase 3 Fork 的主要触发理由
```

### 决策 4：不做独立的 Agent 进程，复用 VS Code Extension Host

```
选择: Comdr Engine 作为一个 VS Code 扩展的依赖运行
不选: 独立 Electron/Node 进程 + VS Code 扩展做薄客户端

理由:
  - 简单: 不需要管理第二个进程的生命周期
  - 部署: 用户安装一个扩展即可（.vsix），不需要额外安装
  - 和 Comdr CLI 模式共享代码: Engine 包不变
  - 降级: 如果 VS Code 扩展出问题，用户可以回退到 CLI 模式
```

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| VS Code Extension API 性能不够 | 中 | 用户体验差 | Phase 1 做性能基准测试，设定量化指标。不达标 → 提前进入 Phase 3 |
| LSP 信息对未打开文件获取有限 | 高 | 上下文不完整 | 用户正在操作的文件已有完整 LSP。对项目全局仍有 bootstrap 正则扫描兜底 |
| DeepSeek API 变更 | 低 | Agent 不可用 | @comdr/llm 独立包，和 VS Code 集成解耦。变更只影响一个包 |
| VS Code 发版破坏兼容性 | 中 | 扩展失效 | Extension API 有稳定性承诺。Phase 3 才涉及内部 API |
| Fork 维护成本超预期 | 中 | 开发资源消耗 | 设定 Fork 触发条件（3.1 节）。不满足就不 Fork |

---

## 九、总结：三个 Phase 的核心取舍

```
Phase 1 (4周, Extension)
  做: LSP 结构化上下文 + LSP 诊断纠正 + 基础 Webview 对话
  不做: Shadow Workspace, Fork, 认知工具重构, 多 Agent 面板
  改: prompt.ts (~50行), reflection.ts (~50行), world-model.ts (~50行)
  加: @comdr/vscode 整个新包
  风险: LSP 只能获取已打开文件的诊断

Phase 2 (4周, Extension 增强)
  做: Agent-Native 认知工具 + 多 Agent 管理面板
  不做: Fork, Shadow Workspace
  改: advanced-tools.ts, subagent.ts
  风险: 没有 Shadow Workspace, 用户仍需手动审查 Agent 的代码

Phase 3 (6周, Fork, 触发条件满足才做)
  做: 3-patch 最小化 Fork + Shadow Workspace + LSP 验证闭环
  不做: 全量 Fork
  加: hidden-editor-window, lsp-bridge-ipc, textmodel-write-hook
  风险: Fork 维护成本。但有明确的触发条件。

北极星 (不实现, 指导设计):
  Mediator Agent — 融入 planner.ts 的路由设计
  IDE = Agent 管理平台 — 指导 Phase 2 面板设计
  ACI 六柱 — 指导 SDB 管线演进
```
