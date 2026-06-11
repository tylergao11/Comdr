# Comdr-Engine

> Cocos Creator 3.x 编辑器操作层。Bridge 运行在编辑器进程内，Overlay 悬浮窗实时监控。

## 架构

```
D:\Comdr (主 agent)
    │
    │  import { runAssemblyProcess } from '@comdr/cocos-engine'
    ▼
@comdr/cocos-engine (Blueprint Pattern)
    │  编排层: Gateway + Commander + DSL + Context Compiler
    │  已迁移至 D:\Comdr\packages\cocos-engine\
    │
    │  Bridge IPC (文件系统)
    ▼
Comdr-Engine (本仓库)
    │  Bridge: Cocos Creator 编辑器扩展
    │  Overlay: Tauri v2 桌面悬浮窗
    │  CLI: 命令行测试入口
```

## 本仓库包结构

```
comdr-engine/
├── packages/
│   ├── bridge/        ← Cocos Creator 编辑器扩展（运行在编辑器进程内）
│   ├── cli/           ← 命令行测试入口
│   └── overlay/       ← Tauri v2 桌面悬浮窗（执行状态实时监控）
├── scripts/           ← 构建/部署脚本
└── docs/              ← 设计文档
```

## 已迁移

`@comdr/core`（编排引擎）→ D:\Comdr\packages\cocos-engine\

包含：Gateway 主循环、Commander LLM API、Context Compiler（Blueprint 编译）、DSL 解析器、5 阶段组装管线、Cocos 世界模型、组件目录、快照/回滚

## Bridge（本仓库维护）

Bridge 是 Cocos Creator 编辑器扩展，运行在编辑器进程内。与 Gateway 通过文件 IPC 通信：

```
Gateway (D:\Comdr)               Bridge (Cocos 编辑器)
     │                                    │
     │  ──write──→  temp/comdr/inbox/     │  (轮询 250ms)
     │                                    │  ──move→ temp/comdr/processing/
     │                                    │  ──execute→ probe/write/edit/save
     │  ←──poll──  temp/comdr/outbox/     │  ←──write──
     │                                    │
     │  ←──poll──  temp/comdr/bridge.json  (心跳/能力，15s)
```

- 5 种任务类型：probe / write / open / edit / save
- Schema 版本化，原子写入（tmp → rename）
- 任务超时 120s，心跳 30s 过期判定

## Overlay

Tauri v2 透明置顶桌面窗口（380×240），Rust 后端 + 原生 JS/CSS 前端。被动观察者——只读文件不调 API。

## 关键原则

| 原则 | 体现 |
|------|------|
| **Blueprint Pattern** | LLM 不读/不写 Cocos 内部格式，两端 Runtime 翻译 |
| **CAG（静态）** | ComponentCatalog HashMap 精确查表 |
| **RAG（动态）** | Probe 协议结构化查询，5 元素分类路由 |
| **精准供给** | 编排层默认给结构骨架（depth=3, structure），LLM 按需展开详情（detail=full, depth=all） |
| **依赖完备** | 自动展开 requires/children/refs |
| **纠错三级** | 静默修正 → 修正告知 → 无法修正返回 errorCode |

## 环境

- Cocos Creator 3.x / Node.js ≥18 / Windows / macOS
- Bridge 部署：`npm run sync-bridge:project`（项目级优先于全局级）
- 改 bridge 源码后需重启 Cocos 扩展

## 快速开始

```bash
git clone <url> comdr-engine && cd comdr-engine
npm install
npm run build
npm run sync-bridge:project    # 部署 Bridge 到 Cocos 项目
```
