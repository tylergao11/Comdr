# TypeScript 编码约定

## 类型系统

- `strict: true` 必须开启。不在 tsconfig 中关闭任何 strict 子选项。
- `noUncheckedIndexedAccess: true` — 数组和 Record 访问必须处理 undefined。
- `verbatimModuleSyntax: true` — type 导入必须显式写 `import type`。
- 禁止 `any`——用 `unknown` 或具体类型替代。`as any` 是架构缺陷的信号。
- 可辨识联合体：所有变体共享一个字面量 `type` 字段，switch 穷尽所有分支。

## 命名

- 类型/接口: PascalCase。函数/变量: camelCase。文件名: kebab-case。枚举值: snake_case 字符串。
- 禁止魔法字符串——定义为 const 对象或 enum。

## 模块

- 每个包必须有一个 `index.ts` 作为公开 API 入口。
- 内部模块按功能拆文件——一个文件不超过 300 行。
- tsconfig `references` 阻止循环依赖。

## 异步

- 优先 async/await，不要混用 Promise.then。
- AbortController 信号必须传播到所有可中断操作。
- AsyncGenerator 用于流式数据——Agent 5 消费 Agent 4 的 Event 流。

## 常见错误

- `Object.keys()` 返回 `string[]` 而非 `(keyof T)[]`。
- `.json()` 返回 `unknown`，必须 type guard 验证。
- `process.cwd()` 在 monorepo 中可能是子包路径，用 `config.project.projectPath`。
