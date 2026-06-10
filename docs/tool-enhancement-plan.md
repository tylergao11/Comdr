# Comdr 工具增强计划

## 原则：只为真实问题拆工具，不为数量拆

每个候选工具必须通过三个问题：
1. 它解决了当前 LLM 无法完成或反复失败的任务吗？
2. 它的输出比 `shell_bash` 的原始文本有结构性优势吗？
3. 它的实现是在复用已有基础设施，还是在造新轮子？

---

## 一、当前 17 个工具的审计

先看已有的有没有问题。

### file_read — 有问题

LLM 读文件时没有摘要选择——要么读全量（吃上下文），要么盲猜 offset/limit（可能跳过关键行）。oh-my-pi 的 read 支持：

- `selector`: 按函数名/类名/行号范围精确定位
- `summarize`: 长文件返回结构化摘要（函数列表 + 签名 + 位置），不是全量文本
- `truncate`: 输出超长时自动截断 + 附 expand 提示

Comdr 的 `file_read` 只有 `path` + `offset` + `limit`。LLM 面对一个 800 行的文件时，它要么全读（浪费 6000 tokens），要么猜测 offset=200, limit=100（可能刚好跳过核心逻辑）。

**方案**：给 `file_read` 加 `mode` 参数——默认 `full`，可选 `summary`（返回函数/类列表 + 签名）或 `selector`（按符号名提取对应代码块）。利用 Bootstrap 已填充的 SemanticMemory 符号位置信息。

### file_grep — 只做了一半

正则搜索是精确匹配——但用户说"找登录逻辑"时 LLM 要猜 pattern。BM25 语义搜索是互补能力。

**方案**：新增 `file_search` 工具，用已有的 `BM25Scorer` + `tokenize` 对文件内容建索引。不是替代 grep——grep 用于精确查找，search 用于语义探索。两者是不同工具。

### file_edit — old_string 脆弱

这是已知问题（Cline no-op）。oh-my-pi 的 hashline 用内容哈希替代字符串匹配，编辑成功率从 6.7% 跳到 68.3%。但 hashline 需要改 LLM 的输出格式——不是简单的工具定义改动。

**暂不改**——等 Hash-Anchor 方向的独立设计。先解决其他更便宜的问题。

---

## 二、真正值得新增的工具

### 1. shell_test — 结构化测试执行（有理由）

**当前问题**：LLM 写 `shell_bash("pnpm test")`，拿到一堆文本输出。它必须自己解析"几个通过几个失败"——经常误读。SDB Step 6 已经有 test runner 自动探测和结构化输出，但这只在 `file_edit`/`file_write` 后自动触发。LLM 不能主动说"跑一下测试看看"并拿到结构化结果。

**复用**：SDB test_feedback.rs 已有完整实现。TS 层 `NativeTools.execute()` 已经返回 `testFeedback: {passed, failed, output, testFile}`。只是当前这个能力隐藏在执行流程中——没有暴露为独立工具。

**工具定义**：

```typescript
{
  name: 'shell_test',
  description: 'Run project tests and return structured pass/fail counts. Auto-detects test runner (vitest/jest/mocha/pytest/cargo).',
  parameters: {
    path: { type: 'string', description: 'Optional: test file or directory. Default: entire project.' },
    filter: { type: 'string', description: 'Optional: test name pattern to filter.' },
  },
  // 返回: { ok, testFeedback: { passed, failed, output, testFile } }
}
```

**为什么不是 `shell_bash("pnpm test")` 的简单封装**：shell_bash 返回字符串。这个工具返回结构化 JSON——`{passed: 12, failed: 3, failures: [{name: "...", message: "..."}]}`。LLM 可以直接用数字做决策，不需要解析自然语言。

### 2. file_search — BM25 语义搜索（有理由）

**当前问题**：`file_grep` 是正则匹配。"找处理登录的代码"→ LLM 猜 `login|auth|signin`，但可能漏了 `credential`、`session`、`oauth`。语义搜索补上这个缺口。

**复用**：`retrieval.ts` 的 `BM25Scorer` + `tokenize` + `contextualPrefix` 完全现成。

**工具定义**：

```typescript
{
  name: 'file_search',
  description: 'Semantic search across project files. Returns ranked list of relevant code sections. Use for exploratory search when you do not know exact symbols or patterns.',
  parameters: {
    query: { type: 'string', description: 'Natural language description of what to find.' },
    topK: { type: 'number', description: 'Max results (default 5).' },
  },
}
```

**为什么不是 `file_grep` 的替代**：grep 找已知的东西（"authMiddleware 在哪里被调用"）。search 找未知的东西（"哪些代码跟认证有关"）。互补。

### 3. memory_recall — 查询历史（有理由）

**当前问题**：EpisodicMemory 在后台自动运行——session 开始时检索相关历史注入 L3。但 LLM 在 mid-task 时不能主动查"上次类似问题我们怎么修的"。

**复用**：`EpisodicMemory.retrieve()` 已实现。只是没暴露为工具。

**工具定义**：

```typescript
{
  name: 'memory_recall',
  description: 'Search past session history for related tasks and their outcomes.',
  parameters: {
    query: { type: 'string', description: 'What to search for in past sessions.' },
  },
  // 返回: [{ task, outcome, filesModified, decisions, timestamp }]
}
```

**为什么有意义**：这不是"自动注入"的替代——自动注入只在 session 开始时跑一次，且只给 Top-3。LLM mid-task 可能需要深度搜索特定话题，比如"所有跟 auth.ts 相关的历史会话"。

### 4. symbol_find — 查符号定义位置（有理由）

**当前问题**：Bootstrap 填充了 SemanticMemory 的符号表。但 LLM 不知道这些数据可以用——它只能通过 file_read + file_grep 去找函数定义。

**复用**：`SemanticMemory.findDefinition()` + `getDependents()` 已实现。

**工具定义**：

```typescript
{
  name: 'symbol_find',
  description: 'Find where a symbol (function, class, variable) is defined in the codebase, and who depends on it.',
  parameters: {
    name: { type: 'string', description: 'Symbol name to search for.' },
  },
  // 返回: { definition: { file, line, kind }, dependents: [{ file, line, kind }] }
}
```

**为什么不是 `lsp_symbols` 的重复**：`lsp_symbols` 依赖 LSP server 运行。`symbol_find` 依赖 Bootstrap 静态分析——不需要 LSP，瞬时响应。两者互补：LSP 有实时性，Bootstrap 有覆盖面。

### 5. tool_search — 工具发现（有理由）

**当前问题**：17 个工具时 LLM 能记住。30+ 个工具时不可能。需要一个工具让 LLM 自己找到正确工具。

**复用**：`ToolRetriever.retrieve()` + `BM25Scorer` 已实现。

**工具定义**：

```typescript
{
  name: 'tool_search',
  description: 'Find the right tool for a task. Returns matching tools with descriptions.',
  parameters: {
    query: { type: 'string', description: 'What you want to do, in natural language.' },
  },
  // 返回: [{ name, description, parameters }]
}
```

这是 oh-my-pi 的 `search-tool-bm25.ts` 的 Comdr 等价物。

---

## 三、不该加的工具（有意识的不要）

| 候选 | 为什么不要 |
|------|-----------|
| shell_format | = `shell_bash("pnpm format")`。无结构化输出，无决策价值。LLM 自己写命令就行。 |
| shell_install | = `shell_bash("pnpm install")`。同上。 |
| file_refactor | 重命名符号是**多步工作流**（搜索 → 逐文件编辑 → 验证），Planner 编排，不是单工具。 |
| file_patch | unified diff 格式对 LLM 生成难度 > old_string/new_string。不是简化，是增加复杂度。 |
| session_summary | 已注入 L4.5。暴露为工具是冗余。 |
| world_model_search | 已注入 L1.x。冗余。 |
| code_list_symbols | = `lsp_structure` + `lsp_symbols`。已有。 |
| task_classify | Planner 做确定性的，LLM 不需要自己判断。 |
| gh_pr_read/create | 当前阶段 Comdr 是本地 agent。GitHub 集成通过 `shell_bash("gh ...")` 即可——结构化 PR 操作等 Comdr 有用户需求再设计。 |

---

## 四、实现路径

### Step 1: 工具注册框架（基础设施）

新建 `packages/engine/src/tools/` 目录。提取一个 **`createTool()` 工厂函数**：

```typescript
// 不再手写 30 行 JSON Schema — 声明式注册
const shellTest = createTool({
  name: 'shell_test',
  description: 'Run project tests with structured output.',
  params: {
    path:  { type: 'string', optional: true, desc: 'Test file or directory' },
    filter: { type: 'string', optional: true, desc: 'Test name pattern' },
  },
  execute: (args, ctx) => ctx.nativeTools.runTest(args.path, args.filter),
});
```

这个工厂自动生成 JSON Schema、参数校验、错误处理。注册一个新工具从 30 行手写降到 8 行声明。

### Step 2: 实现 5 个新工具（按依赖顺序）

| 顺序 | 工具 | 依赖 | 工作量 |
|------|------|------|--------|
| 1 | `tool_search` | ToolRetriever（已有） | 30行 |
| 2 | `file_search` | BM25Scorer（已有）+ 文件索引 | 80行 |
| 3 | `symbol_find` | SemanticMemory（已有） | 40行 |
| 4 | `memory_recall` | EpisodicMemory（已有） | 40行 |
| 5 | `shell_test` | SDB test_feedback（已有） | 50行 |

### Step 3: file_read 增强

给 `file_read` 的 Rust 层加 `mode` 参数，利用 SemanticMemory 符号表实现 `summary` 和 `selector` 模式。

### Step 4: 注册 + 测试

所有新工具注册到 `ToolsRegistry` → `ToolRetriever` 自动索引 → Planner 自动过滤。写 10-15 条单元测试。

---

## 五、工具总数变化

```
当前:    17 个
新增:     5 个 (tool_search, file_search, symbol_find, memory_recall, shell_test)
不增:     8 个 (明确拒绝的候选)
────────────────
最终:    22 个
```

22 个工具，每个都有存在的理由。不是 70 个——因为 oh-my-pi 的 70 个里有一半是基础设施模块（不是 LLM 直接调用的工具），还有一部分是 Comdr 不需要的领域工具（浏览器、图片生成、TTS、SSH、IRC）。
