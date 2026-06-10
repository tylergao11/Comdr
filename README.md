# Comdr

> DeepSeek V4 驱动的通用 coding agent。TypeScript 编排 + Rust 执行。

## 快速开始

```bash
pnpm install && pnpm build && pnpm build:tools
comdr                    # 交互模式
comdr exec "重构 auth"    # 全自动
comdr plan "分析架构"     # 只读
```

## 为什么选 Comdr

| 问题 | 我们的解法 |
|------|-----------|
| LLM 修 bug 反复失败 | Self-Correct：reasoning 回注 + flash 模型纠正 + 自动回滚 |
| 上下文腐烂 | 双窗口 + 智能压缩（50K 触发，flash 模型执行） |
| 缓存浪费 | **95%+** DeepSeek 前缀缓存命中（工具全量 + 上下文后置 + 消息合并） |
| 工具串行慢 | 拓扑并行调度——同层工具并发执行 |
| 模型贵 | 双模型架构——pro 做 coding，flash 做压缩（便宜 10x） |

## 上下文管理

**4 阶段压缩管线**（50K tokens 触发，对齐论文 Lost in the Middle 的 30K 退化线）：

| 阶段 | 方式 | 说明 |
|------|------|------|
| Observe | 差异化压缩 | 错误保留、测试保留、无关 squash |
| Anchor | flash 摘要 | 增量合并结构化摘要 |
| Collapse | 虚拟投影 | 旧消息 → `[history collapsed]` |
| Compact | flash 全量压缩 | 保留双窗口 anchor |

**子系统**：State/Intent 双窗口（重要性加权淘汰）· BM25 跨会话检索 + 反思层 · Graph RAG 拓扑子图注入 · Aider-style 仓库地图 · World Model 多源分块检索。

所有内容截断使用智能模式提取（`smart-truncate.ts`），绝不含糊硬切。

## 22 个工具 + 统一输出

| 类别 | 工具 |
|------|------|
| 文件 | `file_read` `file_write` `file_edit` `file_delete` `file_glob` `file_grep` `file_ls` |
| Shell | `shell_bash` `shell_test` |
| Git | `git_diff` `git_status` `git_log` `git_add` `git_commit` `git_revert` |
| 语义 | `tool_search` `file_search` `symbol_find` `memory_recall` |
| 编排 | `task_spawn` |

**工具工厂** `createTool()` 声明式注册——8 行替代 30 行手写 JSON Schema。

**统一输出格式** `[OK] tool k=v` / `[ERR] tool k=v error=CODE`——Rust + TS + MCP 三层统一，缓存友好。契约定义在 `@comdr/core types.ts`。

## 并行 + 子 Agent

拓扑依赖分析（Kahn BFS）→ 同层并行，层间串行。不同文件的读写并发，同文件冲突自动串行。

子 Agent 确定性 fan-out（`fanOut` / `runSubAgent` / `pipeline`），独立上下文，共享 LLM + tools。

## 双模型

| 角色 | 默认模型 | 职责 |
|------|---------|------|
| PRIMARY | `deepseek-v4-pro` | coding |
| CONTEXT | `deepseek-v4-flash` | 压缩/摘要/反思（便宜 10x） |

模型名唯一真理源：`@comdr/core/types.ts` `MODEL_ROLE` 常量。

## 运行模式

| 命令 | 行为 |
|------|------|
| `comdr` | 交互，破坏性操作确认 |
| `comdr plan` | 只读分析 |
| `comdr exec` | 全自动 |
| `comdr mcp-server` | MCP JSON-RPC endpoint |
| `comdr session list/resume/delete` | 会话管理 |

`@comdr/core` 是类型的唯一真理源。工作规范见 [CLAUDE.md](CLAUDE.md)。
