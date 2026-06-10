/**
 * colors.ts — Comdr TUI 颜色系统
 *
 * 克制调色板，全局唯一颜色定义点。
 *
 * @agent Agent 5 — TUI 渲染器
 */

export const C = {
  accent:    '#c46b3d',   // 暖橙 — 品牌色
  dim:       '#999999',   // 次级文本（提高至 #999 保证终端可读性）
  good:      '#5a9e6f',   // 成功（柔和绿）
  warn:      '#d4a853',   // 警告（暖金）
  bad:       '#d4574a',   // 错误（柔和红）
  think:     '#9b8e7c',   // thinking 文本（暖灰）
  highlight: '#e8c96a',   // ★ 搜索高亮
  bg:        '#2a2a2a',   // 代码块背景
  info:      '#7ea8c4',   // 信息（柔和蓝）
} as const;
