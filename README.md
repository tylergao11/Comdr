# Comdr

> TypeScript 编排层 + Rust 执行层。DeepSeek V4 驱动的通用 coding agent。

## 快速开始

```bash
pnpm install
pnpm build              # 编译全部 TS 包
pnpm build:tools        # 编译 Rust → .node
pnpm typecheck          # 类型检查
```

## 架构

```
┌─ TypeScript 编排层 ─────────────────────────────────────┐
│ @comdr/core   类型 + 配置 + 日志                         │
│ @comdr/llm    DeepSeek V4 客户端 (SSE, retry, cache)     │
│ @comdr/engine ★ 主循环: prompt → plan → reason → LLM    │
│               → tool execute → reflect → compact → loop  │
│ @comdr/ui     TUI (Ink/React) + MCP Server + HTTP        │
├─────────────────────────────────────────────────────────┤
│ @comdr/tools  napi-rs 桥接层                             │
│     │                                                    │
│     ▼                                                    │
│ crates/comdr-tools/   Rust: SDB Gate (6-step) + 16 tools │
└─────────────────────────────────────────────────────────┘
```

## 5 个契约

| Contract | Interface | Implementer | Consumer |
|----------|-----------|-------------|----------|
| A | `IDeepSeekClient` | Agent 2 (`@comdr/llm`) | Agent 4 |
| B | `INativeTools` | Agent 3 (`@comdr/tools` + Rust) | Agent 4 |
| C | `IEngine` | Agent 4 (`@comdr/engine`) | Agent 5 |
| D | `IConfigLoader` | Agent 1 (`@comdr/core`) | Agent 2,4 |
| E | `IEventLogger` | Agent 1 (`@comdr/core`) | Agent 2,4 |

`@comdr/core` 是类型的唯一真理源。跨 Agent 共享的类型只在这里定义。

## 三种运行模式

| Mode | Command | Behavior |
|------|---------|----------|
| Agent | `comdr` | 逐步执行，破坏性操作暂停确认 |
| Plan | `comdr plan` | 只读分析，禁止 destructive tool |
| YOLO | `comdr exec` | 全自动，auto-approve |

`comdr mcp-server` 启动 MCP JSON-RPC endpoint，`comdr session list/resume/delete` 管理会话。

## vs 已知开源 agent 的坑

| 开源 agent 已知坑 | Comdr 对策 |
|---|---|
| Cline 上下文腐烂 | State + Intent 双窗口，4 阶段压缩保护意图 |
| Cline replace_in_file no-op | SDB Step 5: Diff Validate — 实际变更 vs 预期 |
| Cline 循环停滞 | Progress Meter — 2轮零进展=warning, 3轮=abort |
| Cline 过度自信（声称修好）| SDB Step 6: Test Feedback → DeepSeek Self-Correct → 回滚 |
| Agent thinking 丢失 | reasoning_content 完整捕获/注入/修复链 |
| Aider 异步压缩竞态 | 同步压缩，单线程主循环 |
| Cline 修 bug 多次失败 | SDB Step 6c: reasoning_content 回注 + Chat Prefix Completion 自动纠正 |

## 文件组织

```
Comdr/
├── comdr.md            # ★ 项目专属指令（进入工作区自动加载）
├── CLAUDE.md           # 工作规范（所有开发者必读）
├── README.md           # ← 本文件
├── packages/
│   ├── core/src/       # Agent 1: types.ts + contracts.ts + config.ts + logging.ts
│   ├── llm/src/        # Agent 2: client.ts + prompt-cache.ts
│   ├── tools/src/      # Agent 3: napi bridge (1 file)
│   ├── engine/src/     # Agent 4: loop.ts + 15 modules + memory/
│   └── ui/src/         # Agent 5: tui.tsx + mcp-server.ts + app-server.ts + mock-engine.ts
├── crates/comdr-tools/ # Agent 3 Rust: sdb.rs + sdb/test_feedback.rs + snapshot.rs + tools/
└── skills/             # 用户自定义 SKILL.md（渐进式加载）
```

## 依赖方向（编译期强制）

```
@comdr/core  ← 无依赖（纯类型 + 常量）
    ↑
@comdr/llm  @comdr/tools  ← 依赖 core/types + core/contracts
    ↑            ↑
@comdr/engine  ← 依赖 core + llm + tools（集成点）
    ↑
@comdr/ui  ← 依赖 core + engine（展示面）
```

`tsconfig.json` 的 `references` 阻止循环依赖。

## DeepSeek 适配要点

| 规则 | 说明 |
|------|------|
| `reasoning_content` | **必须保留并回传**，丢 = 400 |
| `thinking` | 顶层字段，不是 `extra_body` |
| thinking 开启时 | 不传 `tool_choice` / `temperature` / `top_p` |
| tools 序列化 | `JSON.stringify(sortedKeys)` 保证前缀缓存命中 |
| 不传 `cache_control` | DeepSeek 全自动前缀缓存 |
| 重试 | 429/5xx → 1s→2s→4s, max 3; 401/403 → 不重试 |

详细实现见 [CLAUDE.md](CLAUDE.md) §6.

## 项目专属指令（comdr.md）

Comdr 进入工作区时自动加载 `./comdr.md`，类似 Claude Code 的 `CLAUDE.md`。内容注入到每轮 System Prompt 之后。

- 默认路径：`./comdr.md`（相对于 projectPath）
- 可配置：`.comdr.toml` 中 `[project] comdr_md_path = "docs/agent.md"`
- 文件不存在 → 静默跳过
- 多源自动发现：全局 + world-models + 项目根目录

## SDB Step 6: Test Feedback + DeepSeek Self-Correct

破坏性文件操作（write/edit/delete）执行后自动触发：

```
Step 5: Diff Validate
  ↓
Step 6a: 约定映射找测试文件（9 种约定模式，零 LLM）
Step 6b: 自动探测 test runner（vitest/jest/mocha/cargo/pytest/go/rspec）
Step 6c: shell 跑测试
  ↓ 失败
Step 6d: DeepSeek Self-Correct
  → reasoning_content 回注（模型看到自己的原始推理链）
  → Chat Prefix Completion（`prefix: true` 强制纠正姿态）
  → thinking=enabled:max（side channel 重型推理）
  → 修正后重新 file_edit + 重跑测试
  ↓ 仍失败
Step 6e: 快照回滚 + 返回 test_failed
```

- 测试发现用约定优于配置——零用户设置即可覆盖 80% 项目
- Self-correct 是 DeepSeek 独有的 side channel，不污染主对话上下文
- 实现：[`crates/comdr-tools/src/sdb/test_feedback.rs`](crates/comdr-tools/src/sdb/test_feedback.rs) + [`packages/engine/src/reflection.ts`](packages/engine/src/reflection.ts)

## Planner 6 模式路由

不再对所有请求用同一策略。6 种任务类型自动匹配：

| 模式 | thinking | 触发词示例 | 工具白名单 |
|------|----------|-----------|-----------|
| query | disabled | "查找", "search", "ls", "是什么" | 只读 (file_read, grep, glob, ls, git_*, lsp_*) |
| edit | enabled:high | "修改", "fix", "update", "改" | file_read/write/edit + shell |
| generate | enabled:high | "创建", "generate", "新建" | file_write + shell |
| refactor | enabled:max | "重构", "refactor", "拆分" | 读写 + git_* |
| architect | enabled:max | "设计", "分析", "architecture" | 只读 + lsp_* |
| orchestrate | enabled:high | 默认 fallback | 全部工具 |

停滞时自动升级（high → max）。实现：[`packages/engine/src/planner.ts`](packages/engine/src/planner.ts)

## Skills 渐进式加载

启动时自动扫描 `skills/` 目录的 `SKILL.md` 文件。启动时只注册 name + description，LLM 调用后才注入正文。支持 trigger 关键词自动展开。`skills.ts` 包含完整的 YAML frontmatter 解析器（零外部依赖）和运行时 skill 创建 API。
