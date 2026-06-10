# Node.js / npm / pnpm 约定

## 包管理

- 项目使用 pnpm（不是 npm 或 yarn）。
- `pnpm install` — 安装依赖。`pnpm add` — 添加依赖。`pnpm update` — 更新。
- monorepo: `pnpm-workspace.yaml` 定义工作区。`pnpm -r` 递归执行命令。
- 锁定文件 `pnpm-lock.yaml` 必须提交到 git。

## 模块系统

- 优先 ESM（`"type": "module"` 或 `.mjs`）。CJS 用于旧代码。
- `package.json` exports 字段控制公开 API。
- `import` 使用 `.js` 扩展名（即使源文件是 `.ts`）——TypeScript 编译后兼容。
- `__dirname` 在 ESM 中不可用——用 `import.meta.url` + `fileURLToPath`。

## 文件操作

- 读写用 `node:fs/promises`（async 版本）。不用同步 `readFileSync` 除非启动阶段。
- 路径用 `node:path` 的 `join`/`resolve`，不用字符串拼接。
- `process.cwd()` 获取工作目录。`homedir()` 获取用户目录。

## 进程

- `child_process` 用 `exec`（短命令）或 `spawn`（长命令、流式输出）。
- 超时控制: AbortController + AbortSignal.timeout()。
- 错误处理: 检查 exit code + stderr。

## 常见错误

- `fs.existsSync` → 用 `existsSync` 前先考虑是否有竞态，async 版本无此问题。
- `JSON.parse` 必须 try-catch——数据可能损坏。
- 环境变量: `process.env.X` 类型是 `string | undefined`。
- Windows 兼容: 路径用 `path.join`（自动处理 `/` vs `\`）。
