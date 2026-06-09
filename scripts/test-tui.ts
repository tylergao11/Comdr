/**
 * test-tui.ts — Agent 5 快速验证脚本
 * 用 MockEngine 启动 TUI，展示完整交互效果
 */

import { startTUI } from '../packages/ui/src/tui.js';
import { createMockEngine } from '../packages/ui/src/mock-engine.js';

const engine = createMockEngine();

// 用 "full" 触发完整场景（所有事件类型）
startTUI({
  engine,
  mode: 'agent',
  initialInput: '创建 hello.ts 文件',
});

// Ctrl+C 退出
