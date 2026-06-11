# Comdr

> 通用 coding agent。TypeScript 编排 + Rust 执行。CLI 入口，VS Code 主交互面。

## 快速开始

```bash
pnpm install && pnpm build && pnpm build:tools
```

```bash
comdr                        # 交互模式
comdr exec "重构 auth 模块"    # 全自动执行
comdr plan "分析架构"          # 只读分析
```

VS Code: `code --extensionDevelopmentPath="packages/vscode" .` 或 `F5`

配置 `~/.comdr/config.toml`:
```toml
[llm]
api_key = "sk-..."
```

---

## 能力清单（按模块，可逐条审计）

### 一、主循环（loop.ts）

| # | 能力 | 验证方式 |
|---|------|------|
| 1.1 | 单线程 async generator 主循环，每轮 9 步 | `Engine.run()` 返回 `AsyncGenerator<AgentEvent>` |
| 1.2 | Token 预算管控——超限自动终止 | `agent.tokenBudget` 配置，`loop.ts` 每轮检查 |
| 1.3 | 层级路由——TaskPlanner 根据任务类型选 thinking 模式 | `planner.ts: route()` 返回 `{thinking, mode}` |
| 1.4 | reasoning_content 完整回传链——每轮注入上轮 thinking | `reasoning.ts: inject()/capture()/repairHistory()` |
| 1.5 | 前缀缓存指纹——静态区 hash 比对，检测缓存失效 | `prompt.ts: computeStaticFingerprint()`，`loop.ts` 每轮比对 |
| 1.6 | 4 阶段上下文压缩——观察/锚点/折叠/紧凑 | `context.ts`，增量 mergeSummary |
| 1.7 | 停滞检测——2 轮零进展 warning，3 轮 abort | `progress.ts: ProgressMeter` |
| 1.8 | 会话持久化——session 可 save/resume | `persistence.ts: SessionStore` |

### 二、工具系统

#### 2.1 工具注册与分发

| # | 能力 | 验证方式 |
|---|------|------|
| 2.1.1 | 22 个工具全量发送，LLM 自己选 | `skillsLoader.activeTools()` + MCP + subAgent |
| 2.1.2 | Tool Blueprint 拓扑图——节点+边+L3 分类 | `tool-blueprint/` 编译 `ToolDefinition[]` → `ToolBlueprint` |
| 2.1.3 | tool_explore 按需展开工具详情 | `expander.ts: expandTool()` + `formatExpansion()` |
| 2.1.4 | tool_search 子串+词级匹配搜索工具 | `execute.ts: execToolSearch()` |
| 2.1.5 | 拓扑分层并行执行——层内并行，层间串行 | `scheduler.ts: scheduleParallel()` |

#### 2.2 文件工具（Rust）

| # | 能力 | 验证方式 |
|---|------|------|
| 2.2.1 | file_read — summary(默认)/full/blueprint/selector 四模式 | `file.rs: exec_summary/exec_full/exec_blueprint/exec_selector` |
| 2.2.2 | file_read summary — 符号骨架（Exports/Internal/Imports） | 正则提取 TS/Python/Rust/JS 符号 |
| 2.2.3 | file_read blueprint — AOCI 风格依赖概览 | `exec_blueprint()` — Public API/Internals/Depends on |
| 2.2.4 | file_read selector — 按符号名精确定位 ±10 行上下文 | `exec_selector()` |
| 2.2.5 | file_write — 原子写（tmp+rename） | `file.rs` 原子写入 |
| 2.2.6 | file_edit — old_string 精确匹配替换 | 单次/全量替换，防多匹配 |
| 2.2.7 | file_edit — Hash-Anchor 编辑（anchor 参数） | `anchor` 查表定位原文，无需 LLM 精确复制 |
| 2.2.8 | file_read 输出锚点——summary/blueprint 每符号带 [hash] | `compute_anchor()` + `store_anchor()` |
| 2.2.9 | file_edit/file_write/file_delete 后锚点自动失效 | `clear_anchors_for_file()` |
| 2.2.10 | file_delete | `remove_file` |
| 2.2.11 | file_glob — 通配符匹配，200 上限 | `glob` crate |
| 2.2.12 | file_grep — 正则搜索，250 上限，skip dirs | `regex` crate |
| 2.2.13 | file_ls — 列目录 | `read_dir` |
| 2.2.14 | 相对路径自动解析——拼 project root | `resolve_path()` |
| 2.2.15 | 路径遍历攻击防护——canonicalize + 边界检查 | `validate_and_resolve_path()` |
| 2.2.16 | 大文件保护——>10MB 拒绝 summary，>5MB 拒绝 full | `MAX_READ_SIZE` 常量 |

#### 2.3 Shell 工具

| # | 能力 | 验证方式 |
|---|------|------|
| 2.3.1 | shell_bash — 执行 shell 命令，90s 超时 | `shell.rs` |
| 2.3.2 | shell_test — 结构化测试执行，返回 pass/fail | `shell.rs: exec_shell_test()`，自动探测 test runner |
| 2.3.3 | shell 注入检测——`;`/`&&`/`$()`/反引号/`| bash`/`eval` | `shell.rs` 注入检测 |

#### 2.4 Git 工具

| # | 能力 | 验证方式 |
|---|------|------|
| 2.4.1 | git_diff — 统一 diff 输出 | `git.rs` |
| 2.4.2 | git_status — porcelain 格式 | `git.rs` |
| 2.4.3 | git_log — 提交历史列表 | `git.rs` |
| 2.4.4 | git_add | `git.rs` |
| 2.4.5 | git_commit | `git.rs` |
| 2.4.6 | git_revert | `git.rs` |

#### 2.5 搜索与图查询

| # | 能力 | 验证方式 |
|---|------|------|
| 2.5.1 | file_search — BM25 全文关键词检索，lazy init 索引 | `execute.ts: execFileSearch()` |
| 2.5.2 | symbol_find — 按符号名查定义位置 | `execute.ts: execSymbolFind()` → `SemanticMemory` |
| 2.5.3 | memory_recall — 跨会话情景记忆词级检索 | `execute.ts: execMemoryRecall()` → `EpisodicMemory` |
| 2.5.4 | repo_query — 依赖图查询（hubs/dependents/dependencies/find） | `execute.ts: execRepoQuery()` → `SemanticMemory` |
| 2.5.5 | tool_search — 子串词级匹配搜工具 | `execute.ts: execToolSearch()` |

### 三、SDB 6 步执行管线（Rust）

| # | 步骤 | 验证方式 |
|---|------|------|
| 3.1 | Step 1: Schema Validate — 参数 JSON Schema 校验 | `sdb.rs: validate_schema()` |
| 3.2 | Step 2: Permission Check — 只读/破坏性/需审批 | `sdb.rs: check_permission()` |
| 3.3 | Step 3: Pre-snapshot — 破坏性操作前文件快照 | `snapshot.rs`，UUID 标识 |
| 3.4 | Step 4: Execute — 带超时执行 | `sdb.rs`，per-tool timeout |
| 3.5 | Step 5: Diff Validate — 实际变更 vs 预期对比 | `sdb.rs: validate_diff()` |
| 3.6 | Step 6: Test Feedback — 自动发现 test file → 探测 runner → 执行 → parse 结果 | `test_feedback.rs` |
| 3.7 | 失败自动回滚——snapshot restore | `rollback()` napi export |
| 3.8 | Self-Correct——test_failed → reasoning_content 回注 → prefix completion 强制纠正 | `reflection.ts: selfCorrect()` |

### 四、记忆系统

#### 4.1 Working Memory（会话内）

| # | 能力 | 验证方式 |
|---|------|------|
| 4.1.1 | State Window 信用加权——success×2 - fail×3 + recency | `working.ts: StateEntry` |
| 4.1.2 | 信用 < 0 淘汰，不污染下轮上下文 | `getActivePaths()` 过滤 |
| 4.1.3 | 搜索词关联——file_grep/file_search 查询关联到文件 | `recordSearch()` |
| 4.1.4 | 反馈闭环——activePaths + activeSearches → 下轮 enrichedQuery | `prompt.ts: anchorFromWindows()` |

#### 4.2 Episodic Memory（跨会话）

| # | 能力 | 验证方式 |
|---|------|------|
| 4.2.1 | consolidate——会话结束生成摘要 | `episodic.ts: consolidate()` |
| 4.2.2 | retrieve——词级匹配检索历史会话 | `episodic.ts: retrieve()` |
| 4.2.3 | reflect——LLM 跨会话反思（failure_mode/success_strategy/co_modified） | `episodic.ts: reflect()` |
| 4.2.4 | merge——共享文件分组合并 MetaEpisode | `episodic.ts: merge()` |
| 4.2.5 | 持久化——serialize/deserialize JSON | `episodic.ts` |

#### 4.3 Semantic Memory（代码索引）

| # | 能力 | 验证方式 |
|---|------|------|
| 4.3.1 | 四张图——语义图/时态图/因果图/实体图 | `semantic.ts` |
| 4.3.2 | Bootstrap——项目启动时扫描所有符号+引用 | `bootstrap.rs` → `SemanticMemory` |
| 4.3.3 | 依赖图查询——getDependents/getDependencies/getTopImported/findDefinition | `semantic.ts` |
| 4.3.4 | BFS 邻居检索——从候选实体展开关联 | `retrieveRelevantEntities()` |

#### 4.4 Tool Experience Memory

| # | 能力 | 验证方式 |
|---|------|------|
| 4.4.1 | 每次工具执行后记录——toolName/file/success/error/insight | `tool-experience.ts: record()` |
| 4.4.2 | 检索——按 toolName + filePath 词级匹配历史经验 | `tool-experience.ts: retrieve()` |
| 4.4.3 | 注入——每轮 prompt 末尾追加相关经验 | `loop.ts` 注入 `[exp]` system message |
| 4.4.4 | 确定性洞察生成——规则驱动，不调 LLM | `deriveInsight()` 函数 |

#### 4.5 Self-Evolving Skills

| # | 能力 | 验证方式 |
|---|------|------|
| 4.5.1 | 4 个提炼模板——anchor-edit/shell-test/read-before-edit/diff-before-commit | `skill-evolution.ts: TEMPLATES` |
| 4.5.2 | >= 3 次成功 + 0 次失败 → 提升为 skill | `feed()` |
| 4.5.3 | 注入 prompt——`[evolved]` 前缀 system message | `loop.ts` 注入 |
| 4.5.4 | 持久化——serialize/deserialize | `skill-evolution.ts` |
| 4.5.5 | 不写磁盘、不调 LLM | 纯确定性规则 |

### 五、反思与自检

| # | 能力 | 验证方式 |
|---|------|------|
| 5.1 | Intra-reflection——执行前预判（循环检测/范围漂移） | `reflection.ts: intra()`，规则驱动不调 LLM |
| 5.2 | Inter-reflection——执行后审查（失败时调 LLM 根因分析） | `reflection.ts: inter()` |
| 5.3 | Self-Correct——DeepSeek prefix completion 强制纠正 | `reflection.ts: selfCorrect()` |
| 5.4 | LSP Correct——诊断快照差值 → 确定性回滚/警告 | `reflection.ts: correctByLSP()` |
| 5.5 | 自检管线——内置规则（peer consistency / file size guard） | `self-check.ts: builtinRules` |
| 5.6 | 同辈一致性——同目录同角色文件结构签名比对 | `self-check.ts: siblingConsistencyRule` |
| 5.7 | 自检去重——同文件同规则同偏离不重复报警 | `emittedIssues` Set 去重 |

### 六、Prompt 构造

| # | 能力 | 验证方式 |
|---|------|------|
| 6.1 | 7 层分层 prompt——静态区(L1-L6)+动态区(L7) | `prompt.ts` |
| 6.2 | 静态区前缀缓存稳定——工具定义 sorted_keys 序列化 | `prompt.ts: computeStaticFingerprint()` |
| 6.3 | COMDR.md 多源自动发现——全局/项目/world-models | `world-model.ts: discoverComdrMd()` |
| 6.4 | World Model 词级即时检索——分块+关键词匹配 | `world-model.ts: discoverAndRetrieve()` |
| 6.5 | 个性化 PageRank 仓库地图——chat files 100× / active 50× boost | `repo-map.ts: generateRepoMap()` |
| 6.6 | Tool Blueprint 替代扁平工具列表 | `prompt.ts: setBlueprint()` |

### 七、子智能体系统

| # | 能力 | 验证方式 |
|---|------|------|
| 7.1 | ISubAgent 契约——统一注册/前缀路由/工具暴露 | `subagent-registry.ts` |
| 7.2 | task_spawn——LLM 派生独立子 Agent | `execute.ts: execTaskSpawn()` → `subagent.ts: runSubAgent()` |
| 7.3 | fanOut——并行派生 N 个子 Agent | `subagent.ts: fanOut()` |
| 7.4 | pipeline——流水线处理（阶段间无 Barrier） | `subagent.ts: pipeline()` |
| 7.5 | forkEngine——派生子 Engine，独立 session/working memory/progress | `loop.ts: forkEngine()` |
| 7.6 | 防递归——子 Agent 移除 task_spawn 工具 | `loop.ts` filter `task_spawn` |
| 7.7 | 子 Agent session 不持久化——执行完即销毁 | `runSubAgent()` 用完即弃 |

### 八、MCP 协作

| # | 能力 | 验证方式 |
|---|------|------|
| 8.1 | MCP Client——连接外部 MCP Server | `mcp-client.ts` |
| 8.2 | MCP 工具自动注册——`mcp__` 前缀暴露给 LLM | `mcp-client.ts: getTools()` |
| 8.3 | MCP Server 状态——连接/断开/错误事件 | `AGENT_EVENT.MCP_STATUS` |
| 8.4 | MCP JSON-RPC endpoint——comdr 自身可作 MCP Server | `ui/src/mcp-server.ts` |

### 九、CLI

| # | 能力 | 验证方式 |
|---|------|------|
| 9.1 | 三种运行模式——interactive/plan(只读)/exec(全自动) | `cli.ts` |
| 9.2 | 会话管理——`comdr session list/resume/delete` | `persistence.ts` |

### 十、VS Code 集成

| # | 能力 | 验证方式 |
|---|------|------|
| 10.1 | Chat Panel——React Webview，消息流 + thinking 折叠 | `webview/provider.ts` + `App.tsx` |
| 10.2 | Activity Bar——🤖 图标，点击展开 Chat 面板 | `extension.ts: registerWebviewViewProvider` |
| 10.3 | Config Setup——无 API key 时 webview 内配置 | `ConfigSetup.tsx` |
| 10.4 | LSP Bridge——诊断快照+差值计算，接 Engine self-correct | `lsp-bridge.ts` 实现 `ILSPBridge` |
| 10.5 | LSP Bridge → Engine 接线——`engine.setLSPBridge()` | `extension.ts` |
| 10.6 | VS Code 工具——`vscode_open_editor/vscode_diff/vscode_reveal_line` 等 6 个 | `vscode-tools.ts` |
| 10.7 | 项目根目录自动检测——workspaceFolders | `extension.ts` |

### 十一、LLM 客户端

| # | 能力 | 验证方式 |
|---|------|------|
| 11.1 | DeepSeek API 客户端——chat/chatStream | `@comdr/llm: client.ts` |
| 11.2 | reasoning_content 保留+回传 | `client.ts` 字段透传 |
| 11.3 | Chat Prefix Completion——DeepSeek beta endpoint | `client.ts` |
| 11.4 | 双模型——PRIMARY(pro) + CONTEXT(flash) | `MODEL_ROLE` 常量 |
| 11.5 | 429/5xx 重试 | `client.ts` |

### 十二、配置

| # | 能力 | 验证方式 |
|---|------|------|
| 12.1 | 分层配置——环境变量 > ./.comdr.toml > ~/.comdr/config.toml > 默认值 | `config.ts: loadConfig()` |
| 12.2 | 环境变量映射——COMDR_API_KEY/COMDR_MODEL 等 10 个 | `config.ts: mergeEnvVars()` |
| 12.3 | 热更新——agent.* + comdrMdPath 可热更 | `config.ts: reloadConfig()` |
| 12.4 | 热更新保护——llm.*/mcpServers/projectPath 变更抛错 | `config.ts: IMMUTABLE_ON_RELOAD_PATHS` |

### 十三、子智能体

| # | 子智能体 | 状态 |
|---|------|------|
| 13.1 | @comdr/audit — 代码审计 | LLM discovers + adjudicates from rules，`discoverRules()` |
| 13.2 | @comdr/cocos-engine — Cocos Creator 场景编辑 | 骨架：`project_info` 可用，`scene_probe`/`component_catalog` 需 Bridge IPC |

---

## 开发命令

```bash
pnpm install && pnpm build && pnpm build:tools
pnpm typecheck
pnpm test
```

## 包结构

```
packages/
  core/          Agent 1 — 类型 + 常量 + 契约
  llm/           Agent 2 — DeepSeek API 客户端
  engine/        Agent 4 — 编排核心
  tools/         Agent 3 — napi-rs 桥接层（TS 侧）
  ui/            Agent 5 — CLI / TUI / MCP Server
  vscode/        Agent 6 — VS Code Extension
  audit/         子智能体 — 代码审计
  cocos-engine/  子智能体 — Cocos Creator 场景编辑
crates/
  comdr-tools/   Agent 3 — Rust 执行层
```

依赖方向: `core ← llm ← engine ← ui/vscode`

工作规范见 [CLAUDE.md](CLAUDE.md)，契约系统见 `packages/core/src/contracts.ts`。
