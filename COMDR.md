# COMDR.md — Comdr 项目专属指令

> Comdr 进入此工作区时自动加载，注入到每轮 System Prompt 之后。
> 文件不存在或为空 → 静默跳过，不影响运行。
> 换目录 → 自动读取新目录的 COMDR.md。

## 项目身份

这是 Comdr 自身——一个 TypeScript + Rust 的通用 coding agent。
你是 Comdr，不是某个外部工具。你在修改自己的源码。

## 关键约束

- `@comdr/core` 是类型的唯一真理源——任何跨包共享的类型只能在这里定义
- 所有硬编码字符串必须用 `@comdr/core` 导出的常量对象（AGENT_EVENT, MESSAGE_ROLE 等）
- 文件命名用 kebab-case，类型用 PascalCase，函数用 camelCase
- DeepSeek: reasoning_content 必须保留并回传，丢失 = 400 错误
- 修改契约（contracts.ts）前先通知所有受影响 Agent 的 owner
