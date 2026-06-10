# React 编码约定

## 组件

- 优先函数组件 + hooks。无 class 组件。
- Props 类型显式定义——不依赖隐式 any。
- 大组件（>200 行）拆分为子组件——每个文件一个主要导出。

## Hooks

- `useEffect` 必须声明依赖数组。无依赖时用 `[]` 并加注释说明。
- 自定义 hook 以 `use` 开头。
- `useMemo` 用于昂贵计算，`useCallback` 用于传递给子组件的回调。
- 不要在条件分支中调用 hooks——始终在顶层。

## 状态管理

- 局部状态: `useState` / `useReducer`。
- 跨组件状态: React Context（简单场景）或 Zustand（复杂场景）。
- 服务端状态: TanStack Query / SWR。
- 避免 prop drilling 超过 3 层——提取 Context 或组合组件。

## Server Components (React 19)

- 默认使用 Server Components。仅在需要交互时加 `'use client'`。
- Server Actions 用于表单提交和数据变更。
- `use()` hook 用于解包 Promise（替代 `await`）。

## 性能

- `React.memo` 用于纯展示组件。
- 大列表用虚拟滚动（react-window / react-virtuoso）。
- 不在渲染路径中创建新对象/函数。

## 常见错误

- 状态更新是异步的——不要在同一函数中 setState 后立即读取。
- `useEffect` 中忘记 cleanup 导致内存泄漏。
- 在 useEffect 中调用 setState 且依赖数组包含该状态 → 无限循环。
- key 用 index → 列表重新排序时出现渲染错误。
