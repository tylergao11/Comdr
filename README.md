# Comdr

> DeepSeek V4 驱动的通用 coding agent。TypeScript 编排 + Rust 执行。CLI 入口，VS Code 主交互面。

## 快速开始

```bash
pnpm install && pnpm build && pnpm build:tools
```

### CLI 模式

```bash
comdr                        # 交互模式
comdr exec "重构 auth 模块"    # 全自动执行
comdr plan "分析架构"          # 只读分析
```

### VS Code 模式

```bash
code --extensionDevelopmentPath="packages/vscode" .
```

或 `F5`（launch.json 已配置）。启动后左侧 Activity Bar 出现 🤖 图标，点击打开 Chat 面板。首次使用在面板内填入 DeepSeek API key。

## 架构

```
人类 ──→ VS Code (webview) / CLI (TUI)
                │ Contract C: IEngine
         ┌──────▼──────────────────────┐
         │  Agent 4  @comdr/engine     │  编排核心：9 步主循环
         │  loop · prompt · planner    │  6 模式路由 · 双窗口记忆
         │  reflection · progress      │  self-correct · 停滞检测
         │  context · skills · subagent│  同步压缩 · fan-out 并行
         └──┬──────────────┬───────────┘
    Contract A │              │ Contract B
    (IDeepSeekClient)        │ (INativeTools)
   ┌──────────▼──┐    ┌─────▼──────────────────┐
   │ Agent 2     │    │ Agent 3  comdr-tools   │
   │ @comdr/llm  │    │ Rust / napi-rs          │
   │ DeepSeek    │    │ SDB 6步管线 + 22 tools  │
   │ reasoning   │    │ file · git · shell · lsp│
   └─────────────┘    └────────────────────────┘

   Agent 1  @comdr/core    类型 + 常量 + 契约（唯一真理源）
   Agent 5  @comdr/ui      CLI / TUI / MCP Server
   Agent 6  @comdr/vscode  VS Code Extension（Webview React）
```

## 核心机制

| 坑（开源 agent 已知） | Comdr 的解法 |
|---|---|
| LLM 修 bug 反复失败 | **SDB 6 步**：Schema → 权限 → 快照 → 执行 → Diff 验证 → 测试反馈。失败自动回滚 + reasoning 回注自纠正 |
| 上下文腐烂 | **双窗口**：State Window + Intent Window 重要性加权淘汰。4 阶段智能压缩（50K 触发，flash 模型执行） |
| 工具 no-op | **Diff Validate**：实际变更 vs 预期对比，不一致标记失败 |
| 循环停滞 | **Progress Meter**：2 轮零进展 = warning，3 轮 = abort |
| thinking 丢失 | **reasoning_content 完整回传链**：每轮注入上一轮 thinking，保证 LLM 有完整推理上下文 |
| 缓存命中低 | **95%+ 前缀缓存命中**：工具全量发送 + 上下文后置 + sorted_keys 序列化 |
| 所有任务同一策略 | **Planner 6 模式**：关键词路由，不同任务走不同 prompt 路径 |
| 模型不知道项目约定 | **COMDR.md 自动加载** + World Model 多源分块检索 |

## 工具

| 类别 | 工具 | 数量 |
|---|---|---|
| 文件 | `file_read` `file_write` `file_edit` `file_delete` `file_glob` `file_grep` `file_ls` | 7 |
| Shell | `shell_bash` `shell_test` | 2 |
| Git | `git_diff` `git_status` `git_log` `git_add` `git_commit` `git_revert` | 6 |
| 语义 | `tool_search` `file_search` `symbol_find` `memory_recall` | 4 |
| 编排 | `task_spawn` | 1 |
| VS Code | `vscode_open_editor` `vscode_diff` `vscode_reveal_line` 等 | 6 |

统一输出 `[OK] tool k=v` / `[ERR] tool k=v error=CODE`，Rust + TS + MCP 三层一致。

## VS Code 集成

Phase 1 已交付：

- **Chat Panel** — React Webview，消息流 + thinking 折叠 + diff 审批（Accept/Reject）
- **Activity Bar** — 🤖 图标，点击展开 Chat 面板
- **Config Setup** — 无 API key 时自动弹出配置表单
- **LSP Bridge** — 诊断快照 + 差值计算（为 self-correct 提供编译器事实信号）
- **Shadow Workspace** — 隔离编辑窗口（mock 阶段，Phase 3 启用真实 Fork）
- **6 个 VS Code 工具** — `vscode_open_editor` / `vscode_diff` / `vscode_execute_command` 等

详见 [docs/vscode-integration-plan.md](docs/vscode-integration-plan.md)。

## 运行模式

| 命令 | 权限 | 用途 |
|------|------|------|
| `comdr` | 确认破坏性操作 | 日常交互 |
| `comdr plan` | 只读 | 分析架构、审查代码 |
| `comdr exec` | 全自动 | CI / headless |
| `comdr mcp-server` | — | 启动 MCP JSON-RPC endpoint |
| `comdr session list/resume/delete` | — | 会话管理 |

## 双模型

| 角色 | 默认模型 | 职责 |
|------|---------|------|
| PRIMARY | `deepseek-v4-pro` | 代码生成、推理 |
| CONTEXT | `deepseek-v4-flash` | 压缩摘要、反思（1/10 成本） |

模型配置唯一真理源：`MODEL_ROLE` 常量（`@comdr/core/types.ts`）。

## 开发

```bash
pnpm install          # 安装依赖
pnpm build            # tsc -b 编译全部 TS 包
pnpm build:tools      # Cargo 编译 Rust → .node
pnpm typecheck        # 纯类型检查
pnpm test             # 集成测试
```

### 包结构

```
packages/
  core/       Agent 1 — 类型 + 常量 + 契约（唯一真理源）
  llm/        Agent 2 — DeepSeek API 客户端
  engine/     Agent 4 — 编排核心（主循环、prompt、记忆、反思）
  tools/      Agent 3 — napi-rs 桥接层（TS 侧）
  ui/         Agent 5 — CLI / TUI / MCP Server
  vscode/     Agent 6 — VS Code Extension
crates/
  comdr-tools/   Agent 3 — Rust 执行层（SDB 管线 + 22 工具）
```

### 依赖方向（编译期强制）

```
@comdr/core  ←  纯类型 + 常量，零依赖
@comdr/llm   ←  依赖 core
@comdr/engine ← 依赖 core + llm + tools (napi)
@comdr/ui    ←  依赖 core + engine
@comdr/vscode ← 依赖 core + engine + llm
```

工作规范见 [CLAUDE.md](CLAUDE.md)。契约系统见 `packages/core/src/contracts.ts`。
