# Comdr-Audit

> Agent 5 of [Comdr](https://github.com/comdr) — Trigram-Powered Code Audit Pipeline.
> LLM 是裁判，不是编排者。

## 设计理念

```
编排层 = 快递员。把代码 + 证据标签送到 LLM 手里，然后闭嘴。
LLM   = 裁判。自己读证据，自己下结论。不需要编排层教它怎么想。
```

跟主 Agent 的根本区别：

| | 主 Agent | Audit |
|---|---|---|
| **驱动者** | LLM 驱循环，调工具，做决策 | Trigram 管道驱循环，LLM 只做裁决 |
| **交互** | 多轮对话 | 一次批处理 |
| **LLM 角色** | 推理 + 决策 + 工具调用 | 看证据，判真假 |
| **编排层角色** | 喂上下文，管记忆，检测停滞 | 建索引，抽证据，送快递 |

## 架构

```
项目代码
    │
    ▼
┌──────────────────────────────────────────────┐
│ TIER 0 — 即时 Trigram 索引 (< 1ms, 0 token)   │
│                                              │
│  CodeChunker → TrigramIndex → Rule Match     │
│  按函数分块      256维向量       cosine sim   │
│                                              │
│  → Finding[]                                 │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ TIER 1 — 结构化证据 (纯 trigram, 0 token)      │
│                                              │
│  cross-file search + source/sink 检测         │
│  TrigramIndex.search  detectByTrigram        │
│                                              │
│  → EvidenceLabels                            │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ TIER 2 — LLM 裁决 (DeepSeek V4 Pro)          │
│                                              │
│  system: <rule> metadata   ← KV Cache 锚点   │
│  user:   <code> + <evidence>                 │
│                                              │
│  → { verdict, confidence, evidence }         │
└──────────────────┬───────────────────────────┘
                   │ LLM 不可用时自动降级
                   ▼
┌──────────────────────────────────────────────┐
│ FALLBACK — Heuristic (纯 trigram, 0 token)    │
│  descriptor 余弦相似度 → 确定性裁决            │
└──────────────────────────────────────────────┘
```

## 跟主 Agent 共享什么

```
@comdr/core/trigram.ts  —— textToVector, cosineSimilarity, TrigramIndex
DeepSeek API             —— 同一个 endpoint，同一个 KV Cache
设计模式                  —— "编排层不教 LLM 怎么想"
```

## 不共享什么

```
ContextManager    ← 对话轮次压缩，audit 用不上
WorkingMemory     ← State/Intent Window，audit 无状态
EpisodicMemory    ← 跨会话历史，audit 批处理
ProgressMeter     ← 停滞检测，audit 不需要
```

## 检索 vs 裁决

| | 编排层做 | LLM 做 |
|---|---|---|
| **检索** | trigram 跨文件搜，source/sink 标签 | — |
| **裁决** | 纯 trigram 确定性 fallback | 单次调用，判真假 |

**编排层提供封闭证据集**（AEGIS 原则：证据链里不存在的防护 = 不存在），杜绝 LLM 幻觉出 "maybe there's a WAF"。

## 快速开始

```bash
# Tier 0: 即时 Trigram 扫描 (21 rules, 0 token, < 1s)
npm run audit                   # 扫全项目
npm run audit:demo              # 扫 test/fixtures/
npm run audit:rules             # 列出所有 21 条规则

# Tier 1 + 2: 证据提取 + LLM 裁决 (需 DEEPSEEK_API_KEY)
npm run audit:verify            # 扫描 + 裁决

# Pre-commit
npm run pre-commit              # 只扫 staged files
```

## 21 条语义规则

不再使用正则——每条规则是自然语言 descriptor，trigram 向量匹配。

```
🔴 CRITICAL (4):  SQL注入 · 命令注入 · 代码注入 · 硬编码密钥
🟠 HIGH (7):      NoSQL注入 · XSS(DOM) · XSS(反射) · 弱加密
                   SSRF · 路径遍历 · 原型污染
🟡 MEDIUM (7):    开放重定向 · 反序列化 · 缺失CSRF · Debug模式
                   CORS配置 · 空Catch · N+1查询
🔵 LOW (2):       深度嵌套 · 过多参数
```

## 项目结构

```
packages/audit/src/
├── finding.ts            核心类型 (Finding, CodeContext, Adjudication)
├── config.ts             配置加载
├── interfaces.ts         核心接口
├── pipeline.ts           AuditPipeline (scan → verify → report)
├── debug.ts              结构化调试日志
├── index.ts              统一导出 + MCP 工具
│
├── rules/                规则引擎
│   ├── types.ts          类型 (HeuristicRule, RuleMatch)
│   ├── descriptors.ts    21 条规则的语义 descriptor
│   ├── security.ts       16 条 OWASP/CWE 安全规则
│   ├── quality.ts        5 条质量/性能规则
│   └── engine.ts         规则匹配 (trigram cosine similarity)
│
├── scanner/              Trigram 扫描器
│   ├── scanner.ts        TrigramSemanticScanner
│   └── reporter.ts       报告格式化
│
├── code-chunker.ts       语义代码分块 (函数/类/方法边界)
│
├── code-context.ts       跨文件 trigram 检索
│
├── dialectic/            证据 + 裁决
│   ├── evidence.ts       source/sink/protection trigram 检测
│   ├── prompts.ts        system/user prompt (KV Cache 优化)
│   ├── verifier.ts       DialecticVerifier (单次 LLM 调用)
│   └── adjudicator.ts    heuristicAdjudicate (纯 trigram，0 token)
│
├── llm/                  DeepSeek API 客户端 (强适配)
│   └── client.ts
│
└── subagent-adapter.ts   主 Agent ISubAgent 契约实现
```

## 关键论文

- [AEGIS (2026)](https://ar5iv.labs.arxiv.org/html/2603.20637) — CPG 锚定 + 封闭证据集 + 单 Agent 辩证。核心设计参考。
- [VulTrial (ICSE 2026)](https://arxiv.org/abs/2505.10961) — 无代码锚定的多 Agent 辩论会退化。佐证单 Agent 路线。
- [ContextPilot (ICSE 2026)](https://conf.researchr.org/details/icse-2026/llm4code-2026-papers/33/) — Explorer-Generator 分离。Trigram = Explorer，LLM = Generator。

## DeepSeek API 适配

- **JSON Mode**: `response_format: {type:'json_object'}`，prompt 含 `"json"` 字样 + JSON 格式示例
- **KV Cache**: 系统自动前缀缓存。同 rule 连续调用，system prompt 完全不变 → 自动命中
- **Base URL**: `https://api.deepseek.com/chat/completions`
- **认证**: `DEEPSEEK_API_KEY` 环境变量

---

**Comdr-Audit** — *Don't lint. Audit. Give the LLM evidence, not instructions.*
