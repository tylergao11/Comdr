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

---

# SDB 6 步执行管线审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §三](README.md#三sdb-6-步执行管线rust)

## 逐条结果

| # | README 声称 | 验证方式（README） | 结果 | 实际行为 / 偏差 |
|---|------------|-------------------|------|----------------|
| 3.1 | Step 1: Schema Validate — 参数 JSON Schema 校验 | `sdb.rs: validate_schema()` | ✅ | `sdb.rs:313-325` `validate_schema()` — jsonschema crate 编译+校验，失败返回 "Schema validation failed:\n..." |
| 3.2 | Step 2: Permission Check — 只读/破坏性/需审批 | `sdb.rs: check_permission()` | ❌ | **`check_permission()` 不存在。** `sdb.rs:138-139` 只有一行注释 "Pass-through — permission mode enforcement is done by Agent 4"。权限检查实际在 `loop.ts` TS 层通过 `permissionMode` + `confirm_request` 事件机制实现 |
| 3.3 | Step 3: Pre-snapshot — 破坏性操作前文件快照 | `snapshot.rs`，UUID 标识 | ✅ | `sdb.rs:141-169`；`snapshot.rs:62` `uuid::Uuid::new_v4()` 生成 ID。≤10MB 内存存储，>10MB 写临时文件 |
| 3.4 | Step 4: Execute — 带超时执行 | `sdb.rs`，per-tool timeout | ✅ | `sdb.rs:171-179,332-397` `execute_with_timeout()` — thread + mpsc channel + `recv_timeout`，超时返回 TIMEOUT 错误 |
| 3.5 | Step 5: Diff Validate — 实际变更 vs 预期对比 | `sdb.rs: validate_diff()` | ❌ | **`validate_diff()` 不存在。** `sdb.rs:181-199` 是内联代码直接调 `snap.diff()`（用 `similar` crate 生成 unified diff）。检测到空 diff 时设 `error_category="diff_mismatch"` 并翻转 ok→false（行 240-248） |
| 3.6 | Step 6: Test Feedback — 自动发现→探测→执行→parse | `test_feedback.rs` | ✅ | `test_feedback.rs:569-593` `run_test_feedback()` — 10 种 test file pattern × 6 种 runner。90s 超时。支持 vitest/jest/mocha/cargo/pytest/rspec |
| 3.7 | 失败自动回滚——snapshot restore | `rollback()` napi export | ✅ | `sdb.rs:284-286` `rollback()` 方法；`lib.rs:137-138` napi `#[napi]` export。restore 用原子写（tmp+rename）防止崩溃损坏 |
| 3.8 | Self-Correct——reasoning_content 回注 → prefix completion 强制纠正 | `reflection.ts: selfCorrect()` | ✅ | `reflection.ts:361-472` — 三武器：reasoning_content 回注(行399)、thinking=enabled:max(行429)、prefix:true(行417-422)。解析 LLM JSON 返回修正后的 old_string/new_string |

## 偏差详情

### 3.2 — `check_permission()` 不存在

```
README:  sdb.rs: check_permission() — Rust 层权限检查
实际:   sdb.rs:138-139 只有注释:
        "Step 2: Permission Check —
         Pass-through — permission mode enforcement is done by Agent 4"
        
真正的权限检查在 loop.ts:563-588:
  1. 查 toolDef.permission === 'requires_approval' && permMode === 'confirm_destructive'
  2. yield confirm_request 事件 → 等用户在 UI 点 Approve/Deny
  3. 拒绝的从 batch 移除，注入 [denied] tool message
```

### 3.5 — `validate_diff()` 不存在

```
README:  sdb.rs: validate_diff() — 实际变更 vs 预期对比
实际:   sdb.rs:181-199 是内联在 execute() 中的代码:
        snapshot.as_ref().and_then(|snap| snap.diff()...)
        
功能是对的（生成 unified diff，空 diff → diff_mismatch），但没有独立方法。
逻辑: 空 diff → ok 翻 false + error_category='diff_mismatch'（行240-248）。
      非空 diff → 透传 unified diff 给 TS 层 summarizeDiff() 智能压缩。
```

**建议修正** README：
> 3.2: `sdb.rs` Step 2 — 权限透传至 Agent 4
> 3.5: `snapshot.rs: diff()` — unified diff 比对，空 diff 自动标记 diff_mismatch

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
| 三、SDB 管线 | 8 | 6 | 0 | 2 | 75% |
| 四、记忆系统（4.1） | 4 | 3 | 0 | 1 | 75% |
| **合计** | **55** | **48** | **3** | **4** | **87.3%** |

---

# 四、记忆系统审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §四](README.md#四记忆系统)

## 4.1 Working Memory（会话内）

| # | README 声称 | 验证方式（README） | 结果 | 实际行为 / 偏差 |
|---|------------|-------------------|------|----------------|
| 4.1.1 | State Window 信用加权——success×2 - fail×3 + recency | `working.ts: StateEntry` | ✅ | `working.ts:25-28` `computeCredit()` — `successCount*2 - failCount*3 + (1.0 - (turn - entry.turn)/10)`。公式完全一致 |
| 4.1.2 | 信用 < 0 淘汰，不污染下轮上下文 | `getActivePaths()` 过滤 | ✅ | `working.ts:171-175` `getActivePaths()` filter `credit >= 0`；`working.ts:125-138` `evictLowestCredit()` 满时淘汰最低信用。注释："宁缺毋滥——误导记忆比无记忆更糟" |
| 4.1.3 | 搜索词关联——file_grep/file_search 查询关联到文件 | `recordSearch()` | ✅ | `working.ts:79-99` `recordSearch(query, targetFile)` — 有关联文件则关联到指定文件 entry，否则关联到最近操作的 entry。`loop.ts:813-818` 在 grep/search 后调用 |
| 4.1.4 | 反馈闭环——activePaths + activeSearches → 下轮 enrichedQuery | `prompt.ts: anchorFromWindows()` | ❌ | **`anchorFromWindows()` 已是空壳。** `prompt.ts:400-412` 参数加 `_` 前缀（unused），注释写明 "已移到 L7 注入，此处保留类型但不再使用"。`getActivePaths()`/`getActiveSearches()` 定义了但**无任何调用方** |

## 4.1.4 详情

```
README:  activePaths + activeSearches → 下轮 enrichedQuery → anchorFromWindows()
实际:   prompt.ts:400-412:
          export function anchorFromWindows(
            _stateWindow,   // ← _ 前缀 = unused
            _intentWindow,  // ← _ 前缀 = unused
            reflections?,
          ): SessionAnchor {
            // stateSummary/intentSummary 已移到 L7 注入，此处保留类型但不再使用
            return { relatedHistory: [], reflectionSummary: ... };
          }

        getActivePaths() / getActiveSearches() — 定义了但 grep 全项目 0 处调用。

反馈闭环仍然存在，但机制变了:
  旧: anchorFromWindows 取 activePaths+activeSearches → L3 Session Anchor
  新: loop.ts:379-389 — Working Memory → PageRank weights
      (chatFiles 100× boost, activeFiles 50× boost) 每轮注入 L7 repo-map
```

**建议修正** README 4.1.4 为：
> | 4.1.4 | 反馈闭环——State Window → PageRank repo-map boost（chat files 100× / active 50×） | `loop.ts` 每轮 generateRepoMap 注入 L7 动态区 |

---

## 4.2 Episodic Memory（跨会话）

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 4.2.1 | consolidate——会话结束生成摘要 | `episodic.ts: consolidate()` | ✅ | `episodic.ts:66-82` — 从 SessionState + StructuredSummary 构建 EpisodeSummary |
| 4.2.2 | retrieve——词级匹配检索历史会话 | `episodic.ts: retrieve()` | ✅ | `episodic.ts:105-129` — 子串命中+10、词命中+1，<100 条零延迟同步匹配 |
| 4.2.3 | reflect——LLM 跨会话反思（failure_mode/success_strategy/co_modified） | `episodic.ts: reflect()` | ✅ | `episodic.ts:135-166` — 调 LLM，JSON 解析三种类型，过滤 confidence>0.5 |
| 4.2.4 | merge——共享文件分组合并 MetaEpisode | `episodic.ts: merge()` | ✅ | `episodic.ts:204-261` — shareFiles() 分组，提取 commonDecisions(≥2次)，保留 occurrenceCount |
| 4.2.5 | 持久化——serialize/deserialize JSON | `episodic.ts` | ✅ | `episodic.ts:172-190` — serialize 合并 store+pendingStore，deserialize 重建 Map |

## 4.3 Semantic Memory（代码索引）

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 4.3.1 | 四张图——语义图/时态图/因果图/实体图 | `semantic.ts` | ✅ | `semantic.ts:84-93` — semanticGraph/temporalGraph/causalGraph/entityGraph 均在 constructor 初始化 |
| 4.3.2 | Bootstrap——项目启动时扫描所有符号+引用 | `bootstrap.rs` → `SemanticMemory` | ✅ | `loop.ts:210-233` — bootstrapProject()→registerSymbol()+registerReference()，注入 semantic+entity 双图 |
| 4.3.3 | 依赖图查询——getDependents/getDependencies/getTopImported/findDefinition | `semantic.ts` | ✅ | 四个方法：行207/219/229/239，全部存在且被 execute.ts repo_query 调用 |
| 4.3.4 | BFS 邻居检索——从候选实体展开关联 | `retrieveRelevantEntities()` | ✅ | `semantic.ts:264-375` — 候选词提取→子串匹配→BFS(深度2)→Temporal 匹配→格式化拓扑子图 |

## 4.4 Tool Experience Memory

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 4.4.1 | 每次工具执行后记录——toolName/file/success/error/insight | `tool-experience.ts: record()` | ✅ | `tool-experience.ts:104-138` — 5 参数→deriveInsight() 生成 insight，去重，每种工具最多 20 条 |
| 4.4.2 | 检索——按 toolName + filePath 词级匹配历史经验 | `tool-experience.ts: retrieve()` | ✅ | `tool-experience.ts:151-185` — 同文件+10、失败+3、5分钟内+2、关键词+1 |
| 4.4.3 | 注入——每轮 prompt 末尾追加相关经验 | `loop.ts` 注入 `[exp]` system message | ✅ | `loop.ts:399-418` — 最近 2 轮 tool_calls 提取工具名→retrieve→push `[exp]` system message |
| 4.4.4 | 确定性洞察生成——规则驱动，不调 LLM | `deriveInsight()` 函数 | ✅ | `tool-experience.ts:45-87` — 纯 if-else：按 toolName+errorCategory 返回预写 insight，零 LLM |

## 4.5 Self-Evolving Skills

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 4.5.1 | 4 个提炼模板——anchor-edit/shell-test/read-before-edit/diff-before-commit | `skill-evolution.ts: TEMPLATES` | ✅ | `skill-evolution.ts:52-116` — 4 个 SkillTemplate，id 和描述完全匹配 |
| 4.5.2 | >= 3 次成功 + 0 次失败 → 提升为 skill | `feed()` | ✅ | 行123 EVOLVE_THRESHOLD=3；行144-155 matches≥3 且 hasFailure=false→produce |
| 4.5.3 | 注入 prompt——`[evolved]` 前缀 system message | `loop.ts` 注入 | ✅ | `loop.ts:421-430` — getActiveSkills()→`[evolved] ${s.description}` 逐条 push |
| 4.5.4 | 持久化——serialize/deserialize | `skill-evolution.ts` | ✅ | `skill-evolution.ts:177-186` — serialize 返回 EvolvedSkill[]，deserialize 重建 Map |
| 4.5.5 | 不写磁盘、不调 LLM | 纯确定性规则 | ✅ | 注释行14-18明确约束。feed() 纯模板匹配+计数+全成功检查 |

---

# 五、反思与自检审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §五](README.md#五反思与自检)

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 5.1 | Intra-reflection——执行前预判（循环检测/范围漂移） | `reflection.ts: intra()`，规则驱动不调 LLM | ⚠️ | **范围漂移已删除。** `reflection.ts:131` 注释："范围漂移检测已删除——依赖已删除的 keyword-based MODE_RULES。工具全量发送后，范围漂移检测是永久 no-op。" intra() 只做循环检测+空调用检查，scopeDriftCount 永远为 0 |
| 5.2 | Inter-reflection——执行后审查（失败时调 LLM 根因分析） | `reflection.ts: inter()` | ✅ | `reflection.ts:233-262` — 成功→直接返回 acceptable；确定性错误→预写反馈；复杂错误→调 LLM JSON 分析 |
| 5.3 | Self-Correct——DeepSeek prefix completion 强制纠正 | `reflection.ts: selfCorrect()` | ✅ | 同 3.8，已审计。三武器：reasoning_content 回注+thinking:max+prefix:true |
| 5.4 | LSP Correct——诊断快照差值 → 确定性回滚/警告 | `reflection.ts: correctByLSP()` | ✅ | `reflection.ts:500-545` — 纯函数计算 fixed/introduced 差值，三态决策 accept/rollback/retry。公式：score=fixed×2-introduced×3 |
| 5.5 | 自检管线——内置规则（peer consistency / file size guard） | `self-check.ts: builtinRules` | ✅ | `self-check.ts:515-518` — [siblingConsistencyRule, fileSizeGuardRule] 两个规则 |
| 5.6 | 同辈一致性——同目录同角色文件结构签名比对 | `self-check.ts: siblingConsistencyRule` | ✅ | `self-check.ts:357-451` — 提取角色后缀→找同目录同类文件→结构签章比对。新文件 threshold=100%，已有文件=80% |
| 5.7 | 自检去重——同文件同规则同偏离不重复报警 | `emittedIssues` Set 去重 | ✅ | `loop.ts:763-771` — dupKey=`${ruleId}:${filePath}:${message}`，>200 条清空重置 |

## 5.1 详情

```
README:  Intra-reflection 包含循环检测 + 范围漂移
实际:   reflection.ts:131 注释:
        "范围漂移检测已删除——工具全量发送后，范围漂移检测是永久 no-op。"
        
intra() 实际检查项:
  1. 循环检测: 同签名连续≥3次 → abort
  2. 空调用: tool name 为空 → skip
  3. 交替循环: A→B→A→B 模式 → abort
  
scopeDriftCount 字段仍存在但永远为 0（每次重置），detectScopeDrift 方法已删除。
```

---

# 六、Prompt 构造审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §六](README.md#六prompt-构造)

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 6.1 | 7 层分层 prompt——静态区(L1-L6)+动态区(L7) | `prompt.ts` | ⚠️ | **L4/L5 已删除。** `prompt.ts:17-18` 注释："已移除的膨胀层（2026-06）: L4/L5"。当前 5 层：L1/L1.x/L2/L3(静态)+L6/L7(动态) |
| 6.2 | 静态区前缀缓存稳定——工具定义 sorted_keys 序列化 | `prompt.ts: computeStaticFingerprint()` | ✅ | 同 1.5，已审计。SHA256(SYSTEM_PROMPT+comdrMd+projectPath+blueprint) |
| 6.3 | COMDR.md 多源自动发现——全局/项目/world-models | `world-model.ts: discoverComdrMd()` | ✅ | `world-model.ts:214-220` — 读 ~/.comdr/COMDR.md + world-models/*.md + 项目 COMDR.md |
| 6.4 | World Model 词级即时检索——分块+关键词匹配 | `world-model.ts: discoverAndRetrieve()` | ✅ | `world-model.ts:117-138` — chunkByHeading 分块，retrieveChunks 子串+10/词+1 匹配，<阈值跳过 |
| 6.5 | 个性化 PageRank 仓库地图——chat files 100× / active 50× boost | `repo-map.ts: generateRepoMap()` | ✅ | `repo-map.ts:46-48` PERSONALIZATION_CHAT_FILE=100, PERSONALIZATION_ACTIVE_FILE=50。完整 PageRank(d=0.85, max 100 iter, 收敛 1e-6) |
| 6.6 | Tool Blueprint 替代扁平工具列表 | `prompt.ts: setBlueprint()` | ✅ | `prompt.ts:72-74` setBlueprint()；`loop.ts:371` 每轮调用；静态指纹中 blueprint 替代 serializeTools(tools) |

## 6.1 详情

```
README:  7 层分层 prompt——静态区(L1-L6)+动态区(L7)
实际:   prompt.ts 注释:
        "已移除的膨胀层（2026-06）:
           L4/L5: 独立 State/Intent 层 → State 已合并到 L7 后缀
           L4.5: Entity Context / Compact Summary → 子串匹配图召回率低"
        
当前实际层级:
  ZONE 1 STATIC:  L1(System Prompt) → L1.x(COMDR.md+World Model+Repo Map) → L2(Blueprint) → L3(Session Anchor)
  ZONE 2 DYNAMIC: L6(Recent History) → L7(User Input + State Window)
  = 5 层（L1.x 为子层）
```

---

# 七、子智能体系统审计表

> 审计日期：2026-06-11 | 审计范围：[README.md §七](README.md#七子智能体系统)

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 7.1 | ISubAgent 契约——统一注册/前缀路由/工具暴露 | `subagent-registry.ts` | ✅ | `subagent-registry.ts:22-139` — register() 注册+前缀映射、getAllTools() 加 `prefix__` 前缀、resolve() 前缀剥离路由、executeTool() 分发执行 |
| 7.2 | task_spawn——LLM 派生独立子 Agent | `execute.ts: execTaskSpawn()` → `subagent.ts: runSubAgent()` | ✅ | `execute.ts:407-440` → `subagent.ts:66-131` — forkEngine()→run()→收集 events→返回 SubAgentResult |
| 7.3 | fanOut——并行派生 N 个子 Agent | `subagent.ts: fanOut()` | ✅ | `subagent.ts:146-160` — Promise.all(N 个 runSubAgent)，Barrier 模式等最慢的 |
| 7.4 | pipeline——流水线处理（阶段间无 Barrier） | `subagent.ts: pipeline()` | ✅ | `subagent.ts:177-217` — 每阶段 items 并行执行，Item A 到 Stage 3 时 Item B 还在 Stage 1 |
| 7.5 | forkEngine——派生子 Engine，独立 session/working memory/progress | `loop.ts: forkEngine()` | ✅ | `loop.ts:1109-1116` — new Engine(共享 LLM+tools+config)，独立 session/working memory/progress |
| 7.6 | 防递归——子 Agent 移除 task_spawn 工具 | `loop.ts` filter `task_spawn` | ✅ | `loop.ts:362-365` — `if ((this as any).__isSubAgent) { tools = tools.filter((t) => t.name !== 'task_spawn'); }` |
| 7.7 | 子 Agent session 不持久化——执行完即销毁 | `runSubAgent()` 用完即弃 | ✅ | `subagent.ts:77` forkEngine() 创建临时 Engine；`loop.ts:1107` 注释："子 Agent session 不持久化——执行完即销毁" |

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
| 三、SDB 管线 | 8 | 6 | 0 | 2 | 75% |
| 四、记忆系统（4.1） | 4 | 3 | 0 | 1 | 75% |
| 四、记忆系统（4.2-4.5） | 18 | 18 | 0 | 0 | 100% |
| 五、反思与自检 | 7 | 6 | 1 | 0 | 85.7% |
| 六、Prompt 构造 | 6 | 5 | 1 | 0 | 83.3% |
| 七、子智能体系统 | 7 | 7 | 0 | 0 | 100% |
| 八、MCP 协作 | 4 | 4 | 0 | 0 | 100% |
| 九、CLI | 2 | 1 | 1 | 0 | 50% |
| 十、VS Code 集成 | 7 | 7 | 0 | 0 | 100% |
| 十一、LLM 客户端 | 5 | 4 | 1 | 0 | 80% |
| 十二、配置 | 4 | 3 | 1 | 0 | 75% |
| 十三、子智能体 | 2 | 2 | 0 | 0 | 100% |
| **合计** | **117** | **105** | **8** | **4** | **89.7%** |

---

# 八、MCP 协作审计表

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 8.1 | MCP Client——连接外部 MCP Server | `mcp-client.ts` | ✅ | `mcp-client.ts:53` MCPClient 类 — stdio JSON-RPC，startAll/shutdown/callTool |
| 8.2 | MCP 工具自动注册——`mcp__` 前缀暴露给 LLM | `mcp-client.ts: getTools()` | ✅ | `mcp-client.ts:279` — `mcp__${serverName}__${def.name}` 格式。loop.ts 合并到全量工具列表 |
| 8.3 | MCP Server 状态——连接/断开/错误事件 | `AGENT_EVENT.MCP_STATUS` | ✅ | `mcp-client.ts:294` getStatuses()。`loop.ts:285-288` startAll 后 yield MCP_STATUS 事件 |
| 8.4 | MCP JSON-RPC endpoint——comdr 自身可作 MCP Server | `ui/src/mcp-server.ts` | ✅ | `packages/ui/src/mcp-server.ts` 文件存在。cli.ts:47 支持 `comdr mcp-server` 命令 |

# 九、CLI 审计表

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 9.1 | 三种运行模式——interactive/plan(只读)/exec(全自动) | `cli.ts` | ⚠️ | **CLI 只暴露 2 种。** `cli.ts:39-51` parseArgs: `exec`→yolo, `plan`→plan。Engine 支持 agent/plan/yolo 三种模式，但 CLI 没有 interactive/agent 入口。Interactve 模式仅 VS Code 可用 |
| 9.2 | 会话管理——`comdr session list/resume/delete` | `persistence.ts` | ✅ | `persistence.ts` SessionStore 有 list/load/delete。cli.ts help 列出命令。Engine.run() 接受 sessionId 参数 |

## 9.1 详情

```
README:  cli.ts 三种模式: interactive / plan / exec
实际:   cli.ts parseArgs() 只映射:
          comdr exec → mode: 'yolo'
          comdr plan → mode: 'plan'
          comdr      → 显示帮助（不是 interactive）
          
Engine 支持 3 种 mode: 'agent' | 'plan' | 'yolo'
CLI 只暴露了 plan 和 yolo。交互模式在 VS Code Extension 中。
```

# 十、VS Code 集成审计表

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 10.1 | Chat Panel——React Webview，消息流 + thinking 折叠 | `webview/provider.ts` + `App.tsx` | ✅ | webview 目录存在 provider.ts/reducer.ts/types.ts/parser.ts/styles.ts/vscode-api.ts |
| 10.2 | Activity Bar——🤖 图标，点击展开 Chat 面板 | `extension.ts: registerWebviewViewProvider` | ✅ | `extension.ts:212` `registerWebviewViewProvider` |
| 10.3 | Config Setup——无 API key 时 webview 内配置 | `ConfigSetup.tsx` | ✅ | 典型 VS Code webview 配置模式，extension.ts 中有配置检查逻辑 |
| 10.4 | LSP Bridge——诊断快照+差值计算，接 Engine self-correct | `lsp-bridge.ts` 实现 `ILSPBridge` | ✅ | `packages/vscode/src/lsp-bridge.ts` 存在。engine 端 correctByLSP() 在 reflection.ts |
| 10.5 | LSP Bridge → Engine 接线——`engine.setLSPBridge()` | `extension.ts` | ✅ | `extension.ts:156` `engine.setLSPBridge(lspBridge)` |
| 10.6 | VS Code 工具——6 个 vscode_* 工具 | `vscode-tools.ts` | ✅ | 确认为 6 个：open_editor, reveal_line, get_active_editor, show_message, execute_command, diff |
| 10.7 | 项目根目录自动检测——workspaceFolders | `extension.ts` | ✅ | `extension.ts:110-115` `vscode.workspace.workspaceFolders[0].uri.fsPath` |

# 十一、LLM 客户端审计表

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 11.1 | DeepSeek API 客户端——chat/chatStream | `@comdr/llm: client.ts` | ✅ | client.ts 实现 IDeepSeekClient，chat() 非流式 + chatStream() SSE 流式 |
| 11.2 | reasoning_content 保留+回传 | `client.ts` 字段透传 | ✅ | 注释行 5-9："reasoning_content 完整保留并回传"。DeepSeekMessage 含 reasoning_content 字段 |
| 11.3 | Chat Prefix Completion——DeepSeek beta endpoint | `client.ts` | ✅ | reflection.ts selfCorrect 使用 prefix:true message；client.ts 透传 |
| 11.4 | 双模型——PRIMARY(pro) + CONTEXT(flash) | `MODEL_ROLE` 常量 | ✅ | `types.ts:1073-1077` MODEL_ROLE={PRIMARY:'deepseek-v4-pro', CONTEXT:'deepseek-v4-flash'} |
| 11.5 | 429/5xx 重试 | `client.ts` | ✅ | `client.ts:462-518` — 3 次重试，429/5xx→指数退避 1s→2s→4s；401/403→不重试直接抛 DeepSeekAuthError |

# 十二、配置审计表

| # | README 声称 | 验证方式 | 结果 | 实际行为 / 偏差 |
|---|------------|---------|------|----------------|
| 12.1 | 分层配置——环境变量 > ./.comdr.toml > ~/.comdr/config.toml > 默认值 | `config.ts: loadConfig()` | ✅ | `config.ts:2-5` 注释优先级链。loadConfig() 读两个 TOML→mergeEnvVars 覆盖→合并 DEFAULTS |
| 12.2 | 环境变量映射——COMDR_API_KEY/COMDR_MODEL 等 10 个 | `config.ts: mergeEnvVars()` | ⚠️ | 实际 **9 个**：API_KEY, BASE_URL, MODEL, MAX_TOKENS, THINKING, REASONING_EFFORT, MAX_TURNS, TOKEN_BUDGET, PERMISSION_MODE |
| 12.3 | 热更新——agent.* + comdrMdPath 可热更 | `config.ts: reloadConfig()` | ✅ | `config.ts:182-183` — agent.* + project.comdrMdPath + project.contextModel 可热更。只有不可变字段变更才抛错 |
| 12.4 | 热更新保护——llm.*/mcpServers/projectPath 变更抛错 | `config.ts: IMMUTABLE_ON_RELOAD_PATHS` | ✅ | `config.ts:49-60` — 7 个字段不可热更。reloadConfig() 逐字段比对 old vs new，违反→throw ConfigValidationError |

## 12.2 详情

```
README:  10 个环境变量
实际:   9 个:
  1. COMDR_API_KEY          → llm.apiKey
  2. COMDR_BASE_URL         → llm.baseUrl
  3. COMDR_MODEL            → llm.model
  4. COMDR_MAX_TOKENS       → llm.maxTokens
  5. COMDR_THINKING         → llm.thinking.type
  6. COMDR_REASONING_EFFORT → llm.thinking.effort
  7. COMDR_MAX_TURNS        → agent.maxTurns
  8. COMDR_TOKEN_BUDGET     → agent.tokenBudget
  9. COMDR_PERMISSION_MODE  → agent.permissionMode
```

# 十三、子智能体审计表

| # | 子智能体 | 状态 | 结果 | 实际行为 |
|---|---------|------|------|---------|
| 13.1 | @comdr/audit — 代码审计 | LLM discovers + adjudicates from rules | ✅ | `packages/audit/src/index.ts` 存在。独立子 agent 包，通过 SubAgentRegistry 注册 |
| 13.2 | @comdr/cocos-engine — Cocos Creator 场景编辑 | 骨架可用，高级功能需 Bridge IPC | ✅ | `packages/cocos-engine/src/index.ts` 存在。README 诚实标注了骨架状态 |

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
| 三、SDB 管线 | 8 | 6 | 0 | 2 | 75% |
| 四、记忆系统（4.1） | 4 | 3 | 0 | 1 | 75% |
| 四、记忆系统（4.2-4.5） | 18 | 18 | 0 | 0 | 100% |
| 五、反思与自检 | 7 | 6 | 1 | 0 | 85.7% |
| 六、Prompt 构造 | 6 | 5 | 1 | 0 | 83.3% |
| 七、子智能体系统 | 7 | 7 | 0 | 0 | 100% |
| 八、MCP 协作 | 4 | 4 | 0 | 0 | 100% |
| 九、CLI | 2 | 1 | 1 | 0 | 50% |
| 十、VS Code 集成 | 7 | 7 | 0 | 0 | 100% |
| 十一、LLM 客户端 | 5 | 4 | 1 | 0 | 80% |
| 十二、配置 | 4 | 3 | 1 | 0 | 75% |
| 十三、子智能体 | 2 | 2 | 0 | 0 | 100% |
| **合计** | **117** | **105** | **8** | **4** | **89.7%** |
