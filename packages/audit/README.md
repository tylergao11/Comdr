# Comdr-Audit

> Agent 5 of [Comdr](https://github.com/comdr) — AEGIS 四阶段代码审计管线。

## 设计理念

```
编排层 = 给规则描述 + 给原生工具。LLM 生命周期独立。
LLM   = 发现者 + 证据链构建者 + 辩证裁决者 + 元审计者。
```

工具走主 Agent 原生通路（repo-map 感知、ripgrep、Git 感知），不山寨 fs。

核心原则来自 [AEGIS (2026)](https://ar5iv.labs.arxiv.org/html/2603.20637)：
> 证据链上不存在的防护 = 实际不存在。每条 claim 必须 cite 行号。

## 架构

```
Rules + Project root
        │
        ▼
┌─────────────────────────────────────────┐
│ PHASE I — Clue Discovery                │
│  最坏污点假设，高召回。                    │
│  LLM grep 全项目 → ClueTuple[]           │
│  N 条线索，按严重级排序                   │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│ PHASE II — Evidence Chain (per clue)    │
│  封闭证据集。链上找不到的 = 不存在。       │
│  向后溯源 + 向前追踪 + 保护缺失清单        │
│  → EvidenceChain                        │
│  并行，concurrency=5                     │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│ PHASE III — Dialectic Verification      │
│  不调工具——证据链是封闭事实集。            │
│  Step 1: 事实理解                       │
│  Step 2: Red Team 攻击（cite 行号）      │
│  Step 3: Blue Team 防御（cite 行号）     │
│  Step 4: 证据加权裁决 → Adjudication     │
└──────────────┬──────────────────────────┘
               ▼  (仅 confirmed / warning)
┌─────────────────────────────────────────┐
│ PHASE IV — Meta-Audit                   │
│  独立审查 Phase III 推理。               │
│  四类缺陷: 幽灵防护 | 臆测 | 锚定失败 | 过度信任 │
│  disagree → 回退重跑 Phase III          │
└──────────────┬──────────────────────────┘
               ▼
          AuditedFinding[]
```

## 22 条规则

```
🔴 CRITICAL (4):  SQL注入 · 命令注入 · 代码注入 · 硬编码密钥
🟠 HIGH (9):      NoSQL注入 · XSS(DOM) · XSS(反射) · 弱加密
                   SSRF · 路径遍历 · 原型污染 · 反序列化 · 未处理Promise
🟡 MEDIUM (7):    开放重定向 · Debug模式 · CORS · 缺失CSRF
                   空Catch · 同步IO · N+1查询
🔵 LOW (2):       深度嵌套 · 过多参数
```

## 快速开始

```bash
# 需要 DEEPSEEK_API_KEY
export DEEPSEEK_API_KEY=sk-...

# 独立 CLI 模式（使用内置 StandaloneToolExecutor）
npx tsx src/pipeline.ts

# 主 Agent 子智能体模式（由 engine 注入原生工具 + LLM）
# engine 启动时自动注册 audit 子 Agent
```

## 项目结构

```
packages/audit/src/
├── finding.ts                Finding, Adjudication, VerifiedFinding
├── config.ts                 ComdrConfig + deepMerge
├── interfaces.ts             AuditStats
├── pipeline.ts               AuditPipeline（入口）
├── index.ts                  导出 + toolVerify MCP 工具
├── debug.ts                  结构化调试日志
│
├── dialectic/
│   ├── types.ts              ClueTuple, EvidenceChain, DialecticResult, MetaAuditResult
│   ├── prompts.ts            22 条规则定义（ALL_RULES）
│   ├── phase1-discover.ts    Phase I — 线索发现
│   ├── phase2-evidence.ts    Phase II — 证据链
│   ├── phase3-dialectic.ts   Phase III — 辩证裁决
│   ├── phase4-audit.ts       Phase IV — 元审计
│   └── verifier.ts           四阶段编排器
│
├── tools/
│   └── executor.ts           StandaloneToolExecutor + createComdrToolExecutor
│
└── subagent-adapter.ts       ISubAgent 契约实现
```

## 配置

`comdr-audit.json`（项目根目录，可选）：

```json
{
  "dialectic": {
    "maxFindingsPerRun": 50,
    "phases": {
      "discover": { "enabled": true, "maxToolTurns": 10 },
      "evidence": { "enabled": true, "maxToolTurns": 5 },
      "dialectic": { "enabled": true },
      "metaAudit": { "enabled": true, "requireFor": ["confirmed", "warning"] }
    }
  },
  "pipeline": { "failOnSeverity": "high" }
}
```

---

**Comdr-Audit** — *Closed evidence set. Dialectic verification. Meta-audit veto. No heuristic fallback.*
