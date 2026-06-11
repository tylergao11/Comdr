/**
 * edge-table.ts — 静态拓扑边声明
 *
 * ★ 每条边声明两个工具之间的关系。
 *   编译时由 compileBlueprint() 消费，生成 ToolBlueprint.edges。
 *
 * 边类型:
 *   consumes:       A 的输出 → B 的输入（工作流驱动）
 *   verifies:       A 可验证 B 的结果（验证闭环）
 *   depends_on:     A 必须在 B 之前（前置依赖）
 *   alternative:    A 和 B 可互相替代
 *
 * 命名规则:
 *   主引擎工具 → 裸名（如 "file_read"）
 *   子 agent 工具 → 全名含前缀（如 "audit__scan"）
 *   MCP 工具 → 全名含 mcp__ 前缀
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type { ToolBlueprintEdge } from '@comdr/core';

// ============================================================================
// §1 边表
// ============================================================================

/**
 * ★ 核心拓扑边——定义工具世界的骨架关系。
 *
 * 分组:
 *   1. 搜索→读取（感知链）
 *   2. 读取→修改（操作链）
 *   3. 修改→验证（验证环）
 *   4. Git 流水线
 *   5. 替代关系
 */
export const EDGE_TABLE: ToolBlueprintEdge[] = [
  // ================================================================
  // 感知链: 搜索/发现 → 读取
  // ================================================================
  {
    from: 'file_glob', to: 'file_read',
    type: 'consumes',
    description: 'glob finds file paths → read opens them',
  },
  {
    from: 'file_grep', to: 'file_read',
    type: 'consumes',
    description: 'grep finds matches → read shows surrounding code',
  },
  {
    from: 'file_search', to: 'file_read',
    type: 'consumes',
    description: 'semantic search finds relevant files → read opens them',
  },
  {
    from: 'file_ls', to: 'file_read',
    type: 'consumes',
    description: 'ls lists files → read opens selected ones',
  },
  {
    from: 'lsp_symbols', to: 'file_read',
    type: 'consumes',
    description: 'symbol search finds definitions → read shows full context',
  },
  {
    from: 'symbol_find', to: 'file_read',
    type: 'consumes',
    description: 'symbol lookup finds definitions → read shows code',
  },

  // ================================================================
  // 操作链: 读取 → 修改
  // ================================================================
  {
    from: 'file_read', to: 'file_edit',
    type: 'consumes',
    description: 'read provides exact old_string for edit',
  },
  {
    from: 'file_read', to: 'file_write',
    type: 'consumes',
    description: 'read shows what exists → write overwrites or creates',
  },
  {
    from: 'file_glob', to: 'file_delete',
    type: 'consumes',
    description: 'glob finds files → delete removes targeted ones',
  },

  // ================================================================
  // 验证环: 修改 → 确认
  // ================================================================
  {
    from: 'file_edit', to: 'file_read',
    type: 'verifies',
    description: 'read after edit confirms the diff matches intent',
  },
  {
    from: 'file_write', to: 'file_read',
    type: 'verifies',
    description: 'read after write confirms content is correct',
  },
  {
    from: 'file_edit', to: 'lsp_diagnostics',
    type: 'verifies',
    description: 'diagnostics after edit catch type/syntax errors',
  },
  {
    from: 'file_write', to: 'lsp_diagnostics',
    type: 'verifies',
    description: 'diagnostics after write verify correctness',
  },
  {
    from: 'file_edit', to: 'shell_test',
    type: 'verifies',
    description: 'tests after edit verify behavior unchanged or fixed',
  },
  {
    from: 'git_diff', to: 'file_edit',
    type: 'verifies',
    description: 'diff before commit confirms only intended changes',
  },
  {
    from: 'file_delete', to: 'file_ls',
    type: 'verifies',
    description: 'ls after delete confirms file is gone',
  },

  // ================================================================
  // Git 流水线: 依赖链
  // ================================================================
  {
    from: 'git_add', to: 'git_commit',
    type: 'depends_on',
    description: 'add stages files before commit',
  },
  {
    from: 'git_commit', to: 'git_revert',
    type: 'depends_on',
    description: 'revert needs an existing commit hash',
  },
  {
    from: 'git_diff', to: 'git_add',
    type: 'consumes',
    description: 'diff shows changes → add stages the right ones',
  },

  // ================================================================
  // 替代关系
  // ================================================================
  {
    from: 'file_edit', to: 'file_write',
    type: 'alternative',
    description: 'edit = surgical patch; write = full overwrite',
  },
  {
    from: 'file_grep', to: 'file_search',
    type: 'alternative',
    description: 'grep = exact regex; search = semantic similarity',
  },
  {
    from: 'file_glob', to: 'file_ls',
    type: 'alternative',
    description: 'glob = pattern match; ls = flat listing',
  },
  {
    from: 'lsp_symbols', to: 'symbol_find',
    type: 'alternative',
    description: 'both find symbol definitions by name',
  },
  {
    from: 'shell_bash', to: 'shell_test',
    type: 'alternative',
    description: 'bash = general shell; test = auto-detect test runner',
  },
  {
    from: 'tool_search', to: 'tool_explore',
    type: 'alternative',
    description: 'tool_search = discover tools; tool_explore = deep-dive single tool',
  },

  // ================================================================
  // Sub-Agent: Audit — LLM-driven code audit
  // ================================================================
  {
    from: 'audit__audit', to: 'file_read',
    type: 'consumes',
    description: 'LLM reads files to discover vulnerabilities and gather evidence',
  },
  {
    from: 'audit__audit', to: 'file_grep',
    type: 'consumes',
    description: 'LLM greps for patterns to find vulnerability candidates',
  },
  {
    from: 'audit__audit', to: 'file_glob',
    type: 'consumes',
    description: 'LLM discovers project files before auditing',
  },
  {
    from: 'audit__audit', to: 'file_ls',
    type: 'consumes',
    description: 'LLM lists directories to understand project structure',
  },
  {
    from: 'audit__verify', to: 'file_read',
    type: 'consumes',
    description: 'verify reads surrounding code to gather evidence',
  },
  {
    from: 'audit__verify', to: 'file_grep',
    type: 'consumes',
    description: 'verify greps for corroborating evidence',
  },
];
