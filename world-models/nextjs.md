# Next.js 编码约定

## App Router

- 使用 App Router（`app/` 目录），不用 Pages Router（`pages/`）。
- `layout.tsx` — 共享布局。`page.tsx` — 路由内容。`loading.tsx` — 加载状态。
- `error.tsx` — 错误边界（必须是 Client Component）。
- 路由组 `(groupName)` 用于组织文件而不影响 URL。

## Server Components vs Client

- 默认 Server Component。静态内容、数据获取放服务端。
- `'use client'` 边界尽量下移——只有交互部分用 client。
- 避免在 Client Component 中直接访问数据库/文件系统。

## 数据获取

- Server Component 中: 直接 async 函数 + fetch（Next.js 自动缓存）。
- `next/cache` — `unstable_cache` 用于自定义缓存策略。
- `revalidate` 用于 ISR。
- Server Actions: 表单提交、数据变更。`'use server'` 标记。

## 路由

- 动态路由: `[param]`、`[...slug]`、`[[...param]]`。
- `generateStaticParams` 用于静态生成动态路由。
- `useRouter` / `usePathname` / `useSearchParams` 仅在 Client Component 中使用。

## 常见错误

- 在 Server Component 中使用 hooks → 报错。
- `next/link` 的 `<Link>` 代替 `<a>` 标签。
- `next/image` 的 `<Image>` 必须设置 `width`/`height` 或 `fill`。
- middleware 中不要做重量级操作——它运行在 Edge Runtime。
- Server Actions 的返回值必须可序列化。
