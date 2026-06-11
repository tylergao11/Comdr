# CLAUDE.md — Comdr

## 一、核心设计理念

> **LLM 重推导，编排层重供给。用最小代价给 LLM 最准确的上下文与工具。**

```
LLM 的算力          →  推理、推导、判断、生成
编排层 + 执行层的算力  →  喂什么：上下文检索、工具选取、记忆组装
                       →  兜什么：执行验证、停滞检测、自我纠正
```

**不是**"LLM 不可靠所以我们替它决策"。
**是**"LLM 的 context window 每 token 都应该花在推理上，不该浪费在工具发现和上下文摸索上"。

### 分界原则

| LLM 做 | 编排层做 | 执行层做 |
|--------|---------|---------|
| 理解用户意图 | Embedding 语义检索上下文 | 工具执行 |
| 规划步骤、选择工具 | 组装最相关 context | SDB 6 步验证管线 |
| 控制思考深度 | 工具选取（省 context） | Diff 验证、测试反馈 |
| 代码生成、推理 | 记忆管理（四层） | 确定性的东西 |
| 自然语言理解 | 前缀缓存管理 | 不回滚不漂移的东西 |

**一条判断标准**：这件事是为了"让 LLM 想得更好"还是"怕 LLM 想错"？
- 前者 → 编排层做（检索、组装、省 token）
- 后者 → 问自己：确定性验证能不能兜？能兜就让 LLM 去想，不能兜才加防护

---

## 二、项目概览

Comdr 是通用 coding 级 agent，适配 Cocos 3.x，与 engineAgent 配合完成游戏开发工作流。

```
Comdr = TypeScript 编排层 + Rust 执行层
      + Embedding 检索（语义匹配，非关键词）
      + MCP 协作 Comdr-Engine / Comdr-Art

6 个包:
  @comdr/core     类型 + 常量 + 契约（唯一真理源）
  @comdr/llm      DeepSeek API 客户端
  comdr-tools     Rust 执行层（napi-rs）
  @comdr/engine   编排核心（检索、记忆、主循环、验证）
  @comdr/ui       CLI / TUI / MCP Server
  @comdr/vscode   VS Code Extension
```

---

## 三、铁律

1. **禁止硬编码、魔法数字、魔法字符串。** 同一事实不得在多处抢定义。全局常量统一在 `@comdr/core/types.ts` 底部常量区。

2. **单真理源。** 每个概念只能有一个定义位置。跨包共享 → `@comdr/core`。只属于自己的 → 自己包里。发现重复立即合并。

3. **找根因。** 先问：最佳方案？影响哪些部分？这是真实原因吗？一层层往下挖。

4. **当自己的项目维护。** 不管代码谁写的，看到问题修干净。Comdr 是一个整体。

5. **先讨论，不边想边做。** 不清晰处探讨，达成共识再动手。

6. **检索用 embedding，不用正则/关键词/BM25。** 语义相近 > 字面相同。中文"登录"要能匹配到 `authenticate()`。

---

## 四、开发命令

```bash
pnpm install && pnpm build && pnpm build:tools
pnpm typecheck        # 改前改后各跑一次
pnpm test
```

---

## 五、依赖方向（编译期强制）

```
@comdr/core         ← 零依赖（纯类型 + 常量）
@comdr/llm          ← 依赖 core
@comdr/engine       ← 依赖 core + llm + comdr-tools(napi)
@comdr/ui           ← 依赖 core + engine
@comdr/vscode       ← 依赖 core + engine + llm
```

---

## 六、命名规则

```
类型/接口   → PascalCase     Message, AgentEvent
函数/变量   → camelCase      loadConfig, tokensUsed
文件名      → kebab-case     prompt-cache.ts
包名        → @comdr/xxx
枚举值      → snake_case 字符串  'text_delta'
可辨识联合  → 一律用 type 字段   event.type === 'done'
```

每句回复称呼用户为大哥。
