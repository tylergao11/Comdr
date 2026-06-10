/**
 * tools/index.ts — Comdr 工具系统入口
 *
 * 导出:
 *   - createTool() 工厂函数
 *   - 5 个高级工具定义
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

export { createTool } from './tool-factory.js';
export type { ToolDecl, ParamDecl } from './tool-factory.js';

export {
  TOOL_SEARCH,
  FILE_SEARCH,
  MEMORY_RECALL,
  SYMBOL_FIND,
  SHELL_TEST,
  ADVANCED_TOOLS,
  ADVANCED_TOOL_MAP,
} from './advanced-tools.js';

export { isAdvancedTool, executeAdvancedTool } from './execute.js';
export type { ToolExecContext } from './execute.js';
