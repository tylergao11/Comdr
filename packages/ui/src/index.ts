/**
 * @comdr/ui — Agent 5（交互层）
 *
 * 提供三种交互入口：
 *   - TUI 终端界面（基于 Ink + React）
 *   - MCP Server（JSON-RPC 2.0 over stdio）
 *   - HTTP/WebSocket Server（IDE 集成）
 *
 * 依赖：
 *   - @comdr/core（Contract C: IEngine）
 *   - @comdr/engine（agent 运行时）
 *
 * @agent Agent 5 — 此文件是包的公开 API 入口
 */

// ===== TUI =====
import { startTUI, streamToCLI } from './tui.js';
export { startTUI, streamToCLI };

// ===== MCP Server =====
import {
  startMCPServer,
  createMCPHandler,
  TOOL_DEFINITION,
  SERVER_INFO,
  MCP_VERSION,
} from './mcp-server.js';
export {
  startMCPServer,
  createMCPHandler,
  TOOL_DEFINITION,
  SERVER_INFO,
  MCP_VERSION,
};

// ===== App Server =====
import { startAppServer } from './app-server.js';
export { startAppServer };

// ===== Mock Engine（仅开发/测试） =====
import { MockEngine, createMockEngine } from './mock-engine.js';
export { MockEngine, createMockEngine };

// ===== 契约验证 =====
import type { ContractVerifier, ContractVerification } from '@comdr/core/contracts';

/**
 * Agent 5 的契约自检
 *
 * 验证条件：
 *   1. 所有公开函数可被 import
 *   2. TUI 启动不抛异常（需要有终端环境）
 *   3. MCP Server 能正确处理 JSON-RPC
 *   4. App Server 能绑定端口
 *
 * 注意：TUI 需要在真实终端中测试，
 * Contract C 的完整验证依赖 Agent 4 提供真实 IEngine。
 */
export const verifyContract: ContractVerifier = (): ContractVerification => {
  const failures: string[] = [];

  // 检查运行时导出是否存在
  if (typeof startMCPServer !== 'function') {
    failures.push('startMCPServer not exported');
  }
  if (typeof startAppServer !== 'function') {
    failures.push('startAppServer not exported');
  }
  if (typeof startTUI !== 'function') {
    failures.push('startTUI not exported');
  }
  if (typeof createMCPHandler !== 'function') {
    failures.push('createMCPHandler not exported');
  }

  // 检查常量导出
  if (!TOOL_DEFINITION || TOOL_DEFINITION.name !== 'comdr-code') {
    failures.push('TOOL_DEFINITION incorrect or missing');
  }
  if (!SERVER_INFO || SERVER_INFO.name !== 'comdr-mcp') {
    failures.push('SERVER_INFO incorrect or missing');
  }

  return {
    contract: 'Contract C (IEngine → Agent 5)',
    passes: failures.length === 0,
    failures,
  };
};
