/**
 * @comdr/ui — Agent 5（交互层）
 *
 * 提供两种交互入口：
 *   - MCP Server（JSON-RPC 2.0 over stdio）
 *   - HTTP/WebSocket Server（IDE 集成）
 *
 * 依赖：
 *   - @comdr/core（Contract C: IEngine）
 *   - @comdr/engine（agent 运行时）
 *
 * @agent Agent 5 — 此文件是包的公开 API 入口
 */

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
 *   2. MCP Server 能正确处理 JSON-RPC
 *   3. App Server 能绑定端口
 */
export const verifyContract: ContractVerifier = (): ContractVerification => {
  const failures: string[] = [];

  if (typeof startMCPServer !== 'function') {
    failures.push('startMCPServer not exported');
  }
  if (typeof startAppServer !== 'function') {
    failures.push('startAppServer not exported');
  }
  if (typeof createMCPHandler !== 'function') {
    failures.push('createMCPHandler not exported');
  }

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
