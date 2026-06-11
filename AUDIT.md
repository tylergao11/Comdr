# README 能力清单审计

> 审计日期：2026-06-11 | 审计范围：[README.md §一~二](README.md)

## 逐条结果

| # | README 声称 | 验证方式（README） | 结果 | 实际行为 / 偏差 |
|---|------------|-------------------|------|----------------|
| 1.1 | 单线程 async generator 主循环，每轮 9 步 | `Engine.run()` 返回 `AsyncGenerator<AgentEvent>` | ✅ | `loop.ts:251` 签名确认。9 步分布在主 while 循环中 |
| 1.2 | Token 预算管控——超限自动终止 | `agent.tokenBudget` 配置，`loop.ts` 每轮检查 | ✅ | 轮前检查(行338)+轮末检查(行939)，双保险 |
| 1.3 | 层级路由——TaskPlanner 根据任务类型选 thinking 模式 | `planner.ts: route()` 返回 `{thinking, mode}` | ❌ | `route()` 不存在。实际是 `defaultThinking()` 默认 high + `replan()` 停滞升级。注释写明"关键词匹配已删除" |
| 1.4 | reasoning_content 完整回传链——每轮注入上轮 thinking | `reasoning.ts: inject()/capture()/repairHistory()` | ✅ | 4 阶段闭环：inject → repairHistory → capture → preserveAfterCompact |
| 1.5 | 前缀缓存指纹——静态区 hash 比对，检测缓存失效 | `prompt.ts: computeStaticFingerprint()`，`loop.ts` 每轮比对 | ✅ | SHA256(SYSTEM_PROMPT+comdrMd+projectPath+blueprint)，取前16位。cache hit <80% 告警 |
| 1.6 | 4 阶段上下文压缩——观察/锚点/折叠/紧凑 | `context.ts`，增量 mergeSummary | ✅ | Observe→Anchor→Collapse→Compact，FILL_LINE=80%, DRAIN_LINE=60% |
| 1.7 | 停滞检测——2 轮零进展 warning，3 轮 abort | `progress.ts: ProgressMeter` | ✅ | 多维评分(非简单二值)：diff×2+test×5+info×1+success×2 - 三项罚分。`MAX_STALLED_TURNS=2`, `STALL_ABORT_THRESHOLD=3` |
| 1.8 | 会话持久化——session 可 save/resume | `persistence.ts: SessionStore` | ✅ | save/load/list/delete + episodic/semantic 独立持久化。每轮自动 save，超5MB 裁剪 |

## 1.3 详情

README 声称的 `planner.ts: route()` 方法与实际代码不符：

```
README:  TaskPlanner 根据任务类型选 thinking 模式 → route() 返回 {thinking, mode}
实际:   defaultThinking() 永远返回 {type:'enabled', effort:'high'}
        replan() 仅在停滞时升级到 max —— 停滞驱动，非任务类型驱动
        注释: "关键词匹配已删除。LLM 自己理解用户意图，编排层不替 LLM 做任务分类。"
```

**建议修正** README 1.3 为：
> | 1.3 | 停滞升级——连续停滞时 thinking effort 从 high 升级到 max | `planner.ts: replan()` 停滞检测后覆盖 thinking 配置 |

---

# 工具系统审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §二](README.md#二工具系统)

## 2.1 工具注册与分发

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 2.1.1 | 22 个工具全量发送，LLM 自己选 | `skillsLoader.activeTools()` + MCP + subAgent | ⚠️ | **数量已过时**：BUILTIN_TOOLS=17 + ADVANCED_TOOLS=8 = **25** 基础工具 + MCP + subAgent + skills。`loop.ts:462` 确认全量发送 |
| 2.1.2 | Tool Blueprint 拓扑图——节点+边+L3 分类 | `tool-blueprint/` 编译 `ToolDefinition[]` → `ToolBlueprint` | ✅ | `compiler.ts:34` compileBlueprint() — classify→extract→build IO→lookup edges→assemble。L3 分类由 `classifier.ts` 提供 |
| 2.1.3 | tool_explore 按需展开工具详情 | `expander.ts: expandTool()` + `formatExpansion()` | ✅ | expandTool(行58) 提取完整参数+拓扑关系+替代方案；formatExpansion(行118) 输出 XML 格式详情 |
| 2.1.4 | tool_search 子串+词级匹配搜索工具 | `execute.ts: execToolSearch()` | ✅ | 行178-220：全 query 子串命中=+10分，每个词命中=+1分，取前8个 |
| 2.1.5 | 拓扑分层并行执行——层内并行，层间串行 | `scheduler.ts: scheduleParallel()` | ✅ | Kahn BFS 分层。共享路径+至少一个写操作→冲突→串行；只读操作无条件并行。`loop.ts:556` 调用 |

## 2.2 文件工具（Rust）

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 2.2.1 | file_read 四模式 | `file.rs: exec_summary/exec_full/exec_blueprint/exec_selector` | ✅ | `file.rs:197-209` 匹配 "full"/"blueprint"/"summary"/"selector" 四个分支 |
| 2.2.2 | summary 符号骨架 | 正则提取 TS/Python/Rust/JS 符号 | ✅ | `file.rs:262-342` exec_summary — 用 tree-sitter 提取 → Exports/Internal/Imports 三段 |
| 2.2.3 | blueprint AOCI 风格 | `exec_blueprint()` — Public API/Internals/Depends on | ✅ | `file.rs:402-490` — 📦Imports/📤Public API/🔒Internals/⬆️Depends on |
| 2.2.4 | selector ±10 行上下文 | `exec_selector()` | ✅ | `file.rs:345-393` — SELECTOR_CONTEXT_LINES=10，`>>>` 标记目标行 |
| 2.2.5 | file_write 原子写 | `file.rs` 原子写入 | ✅ | `file.rs:621-643` — 先写 `{path}.comdr-tmp-{pid}`，再 rename 到目标 |
| 2.2.6 | file_edit old_string 精确匹配 | 单次/全量替换，防多匹配 | ✅ | `file.rs:759-767` — 0次→err，>1次且非 replace_all→err（防多匹配） |
| 2.2.7 | file_edit Hash-Anchor | `anchor` 查表定位原文 | ✅ | `file.rs:714-741` — anchor 参数 resolve_anchor() 查表，取原文作 old_string。跨文件 anchor 报 ANCHOR_MISMATCH |
| 2.2.8 | file_read 输出锚点 | `compute_anchor()` + `store_anchor()` | ✅ | `file.rs:18-28` compute_anchor（8 位 hex），summary 行304/326，blueprint 行448 |
| 2.2.9 | 锚点自动失效 | `clear_anchors_for_file()` | ✅ | write(行625)、edit(行777)、delete(行835) 均调 clear_anchors_for_file |
| 2.2.10 | file_delete | `remove_file` | ✅ | `file.rs:790-841` FileDeleteTool — std::fs::remove_file + 锚点清理 |
| 2.2.11 | file_glob 200 上限 | `glob` crate | ✅ | `file.rs:903` MAX_GLOB=200，行918 输出上限 MAX_GLOB_RESULTS=200 |
| 2.2.12 | file_grep 250 上限，skip dirs | `regex` crate | ✅ | `file.rs:64` DEFAULT_MAX_RESULTS=250；行1018-1025 skip node_modules/.git/target/dist 等 11 个目录；行1016 max_depth(20) |
| 2.2.13 | file_ls 列目录 | `read_dir` | ✅ | `file.rs:1082-1167` FileLsTool — dirs first, then files, alphabetical |
| 2.2.14 | 相对路径自动解析 | `resolve_path()` | ✅ | `file.rs:68-77` — 以 `/` 或盘符开头→绝对；否则→拼 project_root |
| 2.2.15 | 路径遍历攻击防护 | `validate_and_resolve_path()` | ✅ | `file.rs:85-116` — canonicalize + starts_with 边界检查。新文件 canon 父目录拼接 |
| 2.2.16 | 大文件保护 | `MAX_READ_SIZE` 常量 | ⚠️ | `file.rs:219` MAX_READ_SIZE=**10MB**，full 和 summary **都用 10MB**。README 称 summary>10MB/full>5MB——full 阈值实际是 10MB 不是 5MB |

## 2.3 Shell 工具

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 2.3.1 | shell_bash 90s 超时 | `shell.rs` | ⚠️ | `shell.rs:68` 默认超时=**120s**（2分钟），README 说 90s |
| 2.3.2 | shell_test 结构化测试 | `shell.rs: exec_shell_test()`，自动探测 test runner | ✅ | 但实现在 `execute.ts:359-404`（TS 层）。detectTestRunner 支持 vitest/jest/cargo/pytest/go |
| 2.3.3 | shell 注入检测 | `shell.rs` 注入检测 | ✅ | `shell.rs:221-306` — 检测危险模式(rm -rf /, fork bomb, dd)、`;`/`&&` 链、`$()`/反引号、`\| bash`/`\| sh`、`eval`/`source` |

## 2.4 Git 工具

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 2.4.1 | git_diff 统一 diff | `git.rs` | ✅ | `git.rs:37-158` — libgit2 实现，支持 staged/blueprint/full 三种模式 |
| 2.4.2 | git_status porcelain 格式 | `git.rs` | ✅ | `git.rs:164-254` — status_flags_to_code 输出标准 2 字符 porcelain 码 |
| 2.4.3 | git_log 提交历史 | `git.rs` | ✅ | `git.rs:260-352` — revwalk 遍历，默认 20 条 |
| 2.4.4 | git_add | `git.rs` | ✅ | `git.rs:358-438` — 支持单文件字符串或路径数组 |
| 2.4.5 | git_commit | `git.rs` | ✅ | `git.rs:444-528` — index.write_tree → find_tree → commit |
| 2.4.6 | git_revert | `git.rs` | ✅ | `git.rs:534-664` — repo.revert + 冲突检测 + auto-commit |

## 2.5 搜索与图查询

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 2.5.1 | file_search BM25 lazy init | `execute.ts: execFileSearch()` | ✅ | `execute.ts:223-257` — 首次调用时 scanProjectFiles，BM25Scorer 索引，文件名去重使用 path 作为 key |
| 2.5.2 | symbol_find 查定义 | `execute.ts: execSymbolFind()` → `SemanticMemory` | ✅ | `execute.ts:288-314` — findDefinition + getDependents，返回类型/路径/位置 |
| 2.5.3 | memory_recall 词级检索 | `execute.ts: execMemoryRecall()` → `EpisodicMemory` | ✅ | `execute.ts:260-285` — EpisodicMemory.retrieve(q, 5)，返回结构化摘要 |
| 2.5.4 | repo_query 依赖图查询 | `execute.ts: execRepoQuery()` → `SemanticMemory` | ✅ | `execute.ts:317-356` — 4 种 action：hubs/dependents/dependencies/find |
| 2.5.5 | tool_search 子串词级匹配 | `execute.ts: execToolSearch()` | ✅ | 同 2.1.4 |

---

## 偏差详情

### 2.1.1 — 工具数量 22→25
BUILTIN_TOOLS (17): file_read, file_write, file_edit, file_delete, file_glob, file_grep, shell_bash, file_ls, git_diff, git_status, git_log, git_add, git_commit, git_revert, lsp_symbols, lsp_diagnostics, lsp_structure
ADVANCED_TOOLS (8): tool_search, tool_explore, file_search, memory_recall, symbol_find, repo_query, shell_test, task_spawn
运行时追加: MCP tools + SubAgent tools + Skills

### 2.2.16 — full 阈值 5MB→10MB
代码 `MAX_READ_SIZE = 10 * 1024 * 1024` 对 full 和 summary 统一使用 10MB 上限，README 说的 5MB 不准确。

### 2.3.1 — 超时 90s→120s
`shell.rs:68` `timeout_ms()` 返回 `120_000`（2分钟），不是 90s。

### 2.3.2 — 实现位置
README 指向 `shell.rs: exec_shell_test()` 但实际实现在 TS 层 `execute.ts:359-404`。功能正确，只是位置描述有偏差。

---

## 汇总

| 模块 | 总数 | ✅ | ⚠️ | ❌ | 通过率 |
|------|------|----|----|----|--------|
| 一、主循环 | 8 | 7 | 0 | 1 | 87.5% |
| 2.1 工具注册与分发 | 5 | 4 | 1 | 0 | 80% |
| 2.2 文件工具 | 16 | 15 | 1 | 0 | 93.8% |
| 2.3 Shell 工具 | 3 | 2 | 1 | 0 | 66.7% |
| 2.4 Git 工具 | 6 | 6 | 0 | 0 | 100% |
| 2.5 搜索与图查询 | 5 | 5 | 0 | 0 | 100% |
| **合计** | **43** | **39** | **3** | **1** | **90.7%** |
