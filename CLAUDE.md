# CLAUDE.md — Comdr 项目工作规范

> 所有 Agent（人类和 AI）在开始任何工作前必须先读此文件。
> README.md 是功能规格，CLAUDE.md 是工作规范。两者互补，不重复。

---

## 一、项目概览

```
Comdr = TypeScript 编排层 + Rust 执行层
       + MCP 协作 Comdr-Engine（编辑器操作） + Comdr-Art（资产生成）

5 个 Agent 分工:
  Agent 1  @comdr/core    类型 + 配置 + 日志 + 契约定义    ← 类型的唯一真理源
  Agent 2  @comdr/llm     DeepSeek API 客户端
  Agent 3  comdr-tools    Rust 执行层（napi-rs）
  Agent 4  @comdr/engine  编排核心（主循环）               ← 集成点
  Agent 5  @comdr/ui      交互层（TUI + MCP Server）
```

---

## 二、命名规则（强制）

```typescript
// 类型/接口    → PascalCase     Message, AgentEvent, IDeepSeekClient
// 函数/变量    → camelCase      loadConfig, tokensUsed
// 文件名       → kebab-case     prompt-cache.ts, mcp-server.ts
// 包名         → @comdr/xxx     @comdr/core, @comdr/llm
// 枚举值       → snake_case 字符串  'text_delta', 'read_only'
// 可辨识联合   → 一律用 type 字段   event.type === 'done'
// 错误码       → UPPER_SNAKE_CASE  'SCHEMA_INVALID'
```

**禁止硬编码字符串**——用 `@comdr/core` 导出的常量对象：

```typescript
// ✅
import { AGENT_EVENT } from '@comdr/core';
emit({ type: AGENT_EVENT.TEXT_DELTA, content: 'hello' });

// ❌
emit({ type: 'text_dalta', content: 'hello' }); // 拼写错误编译器不报
```

可用常量：`AGENT_EVENT`, `TOOL_PERMISSION`, `PERMISSION_MODE`, `RUN_MODE`, `TASK_TYPE`, `THINKING_TYPE`, `THINKING_EFFORT`, `MESSAGE_ROLE`, `SERVER_STATUS`, `ERROR_CATEGORY`, `TERMINATION_REASON`, `SYSTEM`.

---

## 三、契约系统——最重要的一节

### 3.1 核心原则

> **`@comdr/core` 是类型的唯一真理源。任何跨 Agent 共享的类型/接口，只能在这里定义。**

```
@comdr/core  (Agent 1 维护)
  ├── types.ts      ← 所有共享类型定义
  ├── contracts.ts  ← 所有 Agent 间边界接口
  └── index.ts      ← 分层导出
       │
       ├── Agent 2 引用  (只引用，不重新定义)
       ├── Agent 3 对齐  (Rust napi 导出对齐 INativeTools)
       ├── Agent 4 引用  (只引用，不重新定义)
       └── Agent 5 引用  (只引用，不重新定义)
```

### 3.2 五个契约

| 契约 | 接口 | 实现者 | 消费者 |
|------|------|--------|--------|
| A | `IDeepSeekClient` | Agent 2 | Agent 4 |
| B | `INativeTools` | Agent 3 | Agent 4 |
| C | `IEngine` | Agent 4 | Agent 5 |
| D | `IConfigLoader` | Agent 1 | Agent 2,4 |
| E | `IEventLogger` | Agent 1 | Agent 2,4 |

### 3.3 什么放契约层 vs 什么留自己包里

```
这个类型除了你自己，还有没有别的 Agent 需要知道？

  有 → 放 @comdr/core（types.ts 或 contracts.ts）
  没有 → 放自己包里，不导出到 @comdr/core
```

| 例子 | 放哪里 | 谁改 |
|------|--------|------|
| `Message`, `ToolCall`, `AgentEvent` | `@comdr/core` types.ts | 已是共享类型 |
| `IDeepSeekClient` 接口 | `@comdr/core` contracts.ts | 已是契约 |
| Agent 2 内部的 `SSEParser` | `@comdr/llm` 自己包里 | Agent 2 自己 |
| Agent 4 内部的 `MemorySystem` | `@comdr/engine` 自己包里 | Agent 4 自己 |
| 需要新增 `AgentEvent` 的变体 | `@comdr/core` types.ts | Agent 1 改，通知 Agent 4,5 |
| 需要修改 `IDeepSeekClient` 签名 | `@comdr/core` contracts.ts | Agent 1 改，通知 Agent 2,4 |

### 3.4 修改契约的流程

```
1. 提 PR 到 @comdr/core 的 types.ts 或 contracts.ts
2. PR 描述写清楚: 为什么改、影响哪些 Agent
3. 所有受影响的 Agent 的 owner 必须 review
4. 合并后，所有 Agent 重新 npm install + tsc -b 验证编译
```

**现阶段没有正式审批流程，但 PR 必须让受影响的人看到。**

### 3.5 禁止事项

```
❌ 在自己的包里重新定义 Message / ToolCall / AgentEvent 等共享类型
❌ 用 any 绕过类型检查
❌ 在 @comdr/core 里引入运行时依赖（core 只含类型 + 常量 + 纯函数）
❌ 循环依赖: core → llm → engine → core（tsconfig references 已防止）
```

---

## 四、依赖方向（编译期强制）

```
@comdr/core         ← 无依赖（纯类型 + 常量）
@comdr/llm          ← 依赖 @comdr/core
@comdr/engine       ← 依赖 @comdr/core + @comdr/llm + comdr-tools(napi)
@comdr/ui           ← 依赖 @comdr/core + @comdr/engine

tsconfig.json 的 references 已配置好:
  - Agent 2 引用 Agent 1
  - Agent 4 引用 Agent 1 + 2
  - Agent 5 引用 Agent 1 + 4
  - Agent 3 走 napi-rs，不参与 TS 编译
```

---

## 五、开发命令

```bash
pnpm install          # 安装所有依赖
pnpm build            # 编译全部 TS 包
pnpm build:tools      # 编译 Rust → .node 原生模块
pnpm typecheck        # 纯类型检查（不生成文件）
pnpm lint             # ESLint 检查
```

**在改任何东西之前：** `pnpm typecheck` 确认当前状态是绿的。
**在提交任何东西之前：** `pnpm build && pnpm typecheck` 确认零错误。

---

## 六、DeepSeek API 必须遵守的规则（Agent 2 特别重要）

| 规则 | 说明 |
|------|------|
| `reasoning_content` 必须保留并回传 | 丢 = 下一轮 400 错误 |
| `thinking` 是顶层字段 | 不是 `extra_body.thinking` |
| thinking 启用时删除这些参数 | `tool_choice`, `temperature`, `top_p` |
| 不发送 `cache_control` | DeepSeek 全自动前缀缓存 |
| Chat Prefix Completion | beta endpoint, 最后 assistant 设 `prefix: true`。已用于 self-correct（reflection.ts） |
| Self-Correct 调用规则 | `thinking=enabled:max` + 回注 `reasoning_content` + `prefix: true` 强制纠正姿态 |
| 重试策略 | 429/5xx → 1s→2s→4s, max 3 次。401/403 → 不重试 |
| 工具定义序列化 | `JSON.stringify(tools, sortedKeys)` 保证前缀缓存命中 |

---

## 七、Comdr 的独家机制（对比开源 agent 的已知坑）

这些都是 Comdr 存在的理由——写任何相关代码时必须理解它们：

| 开源 agent 已知坑 | Comdr 机制 | 实现在 |
|-------------------|-----------|--------|
| Cline 上下文腐烂 | State Window + Intent Window 双窗口 | Agent 4 memory/working.ts |
| Cline replace_in_file no-op | SDB Step 5: Diff Validate | Agent 3 sdb.rs |
| Cline 循环停滞 | Progress Meter, 2轮零进展=warning, 3轮=abort | Agent 4 progress.ts |
| Cline 过度自信（声称修好） | SDB Step 6: Test Feedback → DeepSeek Self-Correct → 回滚 | Agent 3 sdb/test_feedback.rs + Agent 4 reflection.ts |
| 所有 agent thinking 丢失 | reasoning_content 完整回传链 | Agent 2 client.ts |
| Aider 异步压缩竞态 | 同步压缩，no background thread | Agent 4 context.ts |
| LLM 修 bug 反复失败 | reasoning_content 回注 + Chat Prefix Completion 自动纠正 | Agent 4 reflection.ts selfCorrect() |
| 模型不知道项目约定 | comdr.md 项目专属指令，进入工作区自动加载 | Agent 4 prompt.ts + world-model.ts |
| 所有任务同一策略 | Planner 6 模式关键词路由 | Agent 4 planner.ts |

---

## 八、文件组织约定

```
packages/<name>/src/     ← 源码
packages/<name>/dist/    ← 编译产物（gitignore）
packages/<name>/tests/   ← 单元测试
tests/                   ← 集成测试（跨 Agent）
skills/                  ← 用户自定义 SKILL.md（渐进式加载）
crates/comdr-tools/src/  ← Rust 执行层（sdb.rs + sdb/test_feedback.rs + snapshot.rs + tools/）
comdr.md                 ← 项目专属指令（进入工作区自动加载）
```

每个包的入口文件必须叫 `index.ts`，导出包的公开 API。
内部模块按功能拆文件，用 kebab-case 命名。
新增 Rust 模块必须同时在 `lib.rs` 中注册 napi 导出，并在 TS 契约层同步类型。

**新增模块一览（2026-06）：**
- `packages/engine/src/world-model.ts` — comdr.md 多源自动发现
- `crates/comdr-tools/src/sdb/test_feedback.rs` — SDB Step 6 测试发现 + 执行 + 解析（294 行）
- `packages/core/src/types.ts` — `TestFeedback` 接口、`ToolResult.testFeedback` 字段
- Contract B (`INativeTools`) — 新增 `discardSnapshot()` 方法

---

## 九、TypeScript 严格配置

所有包继承 `tsconfig.base.json`：
- `strict: true`
- `noUncheckedIndexedAccess: true` — 数组/Record 访问必须处理 undefined
- `noImplicitOverride: true` — 子类重写必须加 `override`
- `verbatimModuleSyntax: true` — import type 必须显式写 `type`
- `isolatedModules: true` — 每个文件可独立编译

这意味着：
```typescript
// ✅
import type { Message } from '@comdr/core/types';
import { AGENT_EVENT } from '@comdr/core';

// ❌
import { Message } from '@comdr/core/types'; // type 导入不能用做值
```

---

## 十、工作建议

1. **开始写代码前**，先读 README.md 里自己 Agent 章节的完整内容
2. **遇到需要其他 Agent 提供的类型**，去 `@comdr/core` 查，没有就加
3. **遇到需要在契约接口上加方法**，先问消费者是否真的需要，再改 contracts.ts
4. **Agent 2 和 Agent 3 可以完全并行开发**——它们之间没有依赖
5. **Agent 4 开始前**，Agent 1/2/3 的核心接口必须稳定
6. **Agent 5 开始前**，Agent 4 的 IEngine 接口必须稳定
