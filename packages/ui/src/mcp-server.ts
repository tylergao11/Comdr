/**
 * mcp-server.ts — Comdr MCP Server
 *
 * JSON-RPC 2.0 over stdio 实现。让外部 Agent（Comdr-Engine, Comdr-Art）
 * 通过标准 MCP 协议调用 Comdr 的 coding agent 能力。
 *
 * 规范参考：https://modelcontextprotocol.io/specification/2025-06-18/
 *
 * 工具名：comdr-code
 * 参数：{ request, projectPath, sessionId? }
 *
 * @agent Agent 5 — MCP 入口
 */

import { createInterface } from 'node:readline';
import type { IEngine, RunMode } from '@comdr/core';
import { AGENT_EVENT, RUN_MODE } from '@comdr/core';

import { SYSTEM } from '@comdr/core';

/** MCP tool call 响应最大字符数——来自 @comdr/core 唯一配置源 */
const MAX_OUTPUT_CHARS = SYSTEM.MCP_MAX_OUTPUT_CHARS;

// ============================================================================
// JSON-RPC 2.0 类型
// ============================================================================

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JSONRPCError;
}

interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// MCP 常量
// ============================================================================

const MCP_VERSION = '2025-06-18';
const PROTOCOL_VERSION = '1.0.0';

const SERVER_INFO = {
  name: 'comdr-mcp',
  version: '0.1.0',
};

const TOOL_DEFINITION = {
  name: 'comdr-code',
  description:
    'Execute a coding task using the Comdr agent. The agent can read, write, and edit files, run shell commands, and interact with git. Use this for any programming task including code generation, refactoring, debugging, and project analysis.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      request: {
        type: 'string' as const,
        description: 'Natural language description of what to do. Be specific about files, changes, and expected outcomes.',
      },
      projectPath: {
        type: 'string' as const,
        description: 'Absolute path to the project root directory.',
      },
      sessionId: {
        type: 'string' as const,
        description: 'Optional session ID to resume a previous session. Omit to start a new session.',
      },
      mode: {
        type: 'string' as const,
        enum: ['plan', 'agent', 'yolo'],
        description: 'Execution mode: plan (analysis only), agent (step-by-step confirmation), yolo (auto-approve all). Default: agent.',
      },
    },
    required: ['request', 'projectPath'],
  },
};

// ============================================================================
// 错误码
// ============================================================================

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_EXECUTION_FAILED: -32000,
  SESSION_NOT_FOUND: -32001,
} as const;

function makeError(code: number, message: string, data?: unknown): JSONRPCError {
  return { code, message, data };
}

// ============================================================================
// MCP Server 核心
// ============================================================================

interface MCPServerOptions {
  engine: IEngine;
  /** 可选：覆盖默认 projectPath */
  projectPath?: string;
}

/**
 * 启动 MCP Server（stdio 模式）
 *
 * 在独立进程中运行，通过 stdin/stdout 与 MCP client 通信。
 * 使用方式：
 *   startMCPServer({ engine });
 */
export function startMCPServer(opts: MCPServerOptions): void {
  const { engine, projectPath: defaultProjectPath } = opts;

  // 使用 readline 逐行读取 stdin
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // 写 JSON-RPC 响应到 stdout
  function respond(id: string | number | null, result?: unknown, error?: JSONRPCError): void {
    const resp: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: id ?? null,
    };
    if (error) {
      resp.error = error;
    } else {
      resp.result = result;
    }
    process.stdout.write(JSON.stringify(resp) + '\n');
  }

  // 写通知（无 id）
  function notify(method: string, params?: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      params,
    };
    process.stdout.write(JSON.stringify(notification) + '\n');
  }

  // 写日志到 stderr（MCP 规范允许，client 选择显示或忽略）
  function log(level: string, message: string): void {
    process.stderr.write(`[comdr-mcp] [${level}] ${message}\n`);
  }

  // 处理单个 JSON-RPC 请求
  async function handleRequest(req: JSONRPCRequest): Promise<void> {
    const { id, method, params } = req;

    // 通知（无 id）：不回复
    if (id === undefined || id === null) {
      switch (method) {
        case 'notifications/initialized':
          log('info', 'Client initialized');
          return;
        case 'notifications/cancelled':
          log('info', 'Client cancelled request');
          engine.abort();
          return;
        default:
          log('warn', `Unknown notification: ${method}`);
          return;
      }
    }

    // 请求（有 id）：必须回复
    try {
      switch (method) {
        // ===== 生命周期 =====
        case 'initialize':
          handleInitialize(id, params);
          break;

        case 'ping':
          respond(id, {});
          break;

        // ===== 工具发现 =====
        case 'tools/list':
          respond(id, { tools: [TOOL_DEFINITION] });
          break;

        case 'tools/call':
          await handleToolCall(id, params);
          break;

        // ===== 资源（可选） =====
        case 'resources/list':
          respond(id, { resources: [] });
          break;

        case 'prompts/list':
          respond(id, { prompts: [] });
          break;

        default:
          respond(id, undefined, makeError(ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${method}`));
      }
    } catch (err) {
      log('error', `Handler error: ${String(err)}`);
      respond(id, undefined, makeError(ERROR_CODES.INTERNAL_ERROR, String(err)));
    }
  }

  function handleInitialize(id: string | number, _params?: Record<string, unknown>): void {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
    });
  }

  async function handleToolCall(id: string | number, params?: Record<string, unknown>): Promise<void> {
    const toolParams = (params as Record<string, unknown>) ?? {};

    // 校验必填参数
    const request = toolParams['request'];
    const projectPath = toolParams['projectPath'] ?? defaultProjectPath;

    if (typeof request !== 'string' || !request.trim()) {
      respond(id, undefined, makeError(ERROR_CODES.INVALID_PARAMS, 'Missing required parameter: request (string)'));
      return;
    }
    if (typeof projectPath !== 'string' || !projectPath.trim()) {
      respond(id, undefined, makeError(ERROR_CODES.INVALID_PARAMS, 'Missing required parameter: projectPath (string)'));
      return;
    }

    const sessionId = typeof toolParams['sessionId'] === 'string' ? toolParams['sessionId'] : undefined;
    const mode: RunMode =
      toolParams['mode'] === RUN_MODE.PLAN || toolParams['mode'] === RUN_MODE.YOLO
        ? toolParams['mode']
        : RUN_MODE.AGENT;

    log('info', `Executing: "${request.slice(0, 100)}" [${mode}]`);

    try {
      const parts: string[] = [];
      let finalResult = '';
      let lastNotify = Date.now();

      for await (const event of engine.run(request, mode, sessionId)) {
        switch (event.type) {
          case AGENT_EVENT.TEXT_DELTA:
            parts.push(event.content);
            break;
          case AGENT_EVENT.TOOL_CALL:
            parts.push(`\n[Tool: ${event.call.function.name}]`);
            break;
          case AGENT_EVENT.TOOL_RESULT:
            if (event.result.ok) {
              parts.push(`\n[OK: ${event.result.toolName}: ${event.result.diffSummary ?? event.result.content ?? ''}]`);
            } else {
              parts.push(`\n[FAIL: ${event.result.toolName}: ${event.result.errorCategory ?? 'execution_error'}]`);
            }
            break;
          case AGENT_EVENT.THINKING_DELTA:
            // MCP 默认不暴露 thinking 内容
            break;
          case AGENT_EVENT.SESSION_STARTED:
            // 内部生命周期事件，不输出到 MCP 响应
            break;
          case AGENT_EVENT.TURN_BEGIN:
            // 内部生命周期事件，不输出到 MCP 响应
            break;
          case AGENT_EVENT.TOKEN_USAGE:
            // token 用量由 Engine 内部追踪，不暴露给 MCP 调用方
            break;
          case AGENT_EVENT.MCP_STATUS:
            // MCP Server 状态仅在 TUI 展示，不通过 MCP 协议回传
            break;
          case AGENT_EVENT.PROGRESS_WARNING:
            parts.push(`\n[WARN: ${event.message}]`);
            break;
          case AGENT_EVENT.DONE:
            finalResult = event.result.summary;
            break;
          case AGENT_EVENT.ERROR:
            parts.push(`\n[ERROR: ${event.code} — ${event.message}]`);
            break;
        }

        // ★ 每 500ms 发送一次 MCP progress notification（长任务不沉默）
        const now = Date.now();
        if (now - lastNotify > 500) {
          const lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
          notify('notifications/progress', {
            progress: parts.length,
            total: undefined, // 未知总数
            message: lastPart ? lastPart.slice(-200) : 'working...',
          });
          lastNotify = now;
        }
      }

      let output = parts.join('') + (finalResult ? `\n\n---\n${finalResult}` : '');
      // ★ 防止长会话导致 MCP 响应过大
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[truncated — output exceeded ${MAX_OUTPUT_CHARS} chars]`;
      }

      respond(id, {
        content: [
          {
            type: 'text',
            text: output || '(no output)',
          },
        ],
      });
    } catch (err) {
      log('error', `Execution error: ${String(err)}`);
      respond(
        id,
        undefined,
        makeError(ERROR_CODES.TOOL_EXECUTION_FAILED, `Agent execution failed: ${String(err)}`),
      );
    }
  }

  // ===== 主循环 =====
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JSONRPCRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      // parse error — 按 JSON-RPC 规范，id 设为 null
      respond(null, undefined, makeError(ERROR_CODES.PARSE_ERROR, 'Invalid JSON'));
      return;
    }

    if (!req.jsonrpc || req.jsonrpc !== '2.0') {
      respond(req.id ?? null, undefined, makeError(ERROR_CODES.INVALID_REQUEST, 'Missing or invalid jsonrpc field'));
      return;
    }

    if (!req.method) {
      respond(req.id ?? null, undefined, makeError(ERROR_CODES.INVALID_REQUEST, 'Missing method field'));
      return;
    }

    handleRequest(req);
  });

  rl.on('close', () => {
    log('info', 'stdin closed, shutting down');
    process.exit(0);
  });

  // 确保 stdout 不被缓冲
  if (process.stdout.isTTY === false) {
    // 非 TTY 模式（pipe 连接），Node 默认行缓冲，OK
  }

  log('info', `MCP Server started (v${PROTOCOL_VERSION}, spec ${MCP_VERSION})`);
  log('info', `Registered 1 tool: comdr-code`);
}

// ============================================================================
// 公开 API（programmatic usage）
// ============================================================================

/**
 * 创建一个 MCP Server 处理函数——用于嵌入已有进程
 * 返回 (line: string) => string 的同步处理接口。
 *
 * 注意：startMCPServer 更适合独立进程模式。
 * 此函数适合测试或自定义集成。
 */
export function createMCPHandler(engine: IEngine): (line: string) => string {
  // 简单实现——完整版见 startMCPServer
  return (line: string): string => {
    try {
      const req: JSONRPCRequest = JSON.parse(line);

      if (req.method === 'initialize') {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
      }

      if (req.method === 'tools/list') {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: { tools: [TOOL_DEFINITION] },
        });
      }

      return JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'Use startMCPServer() for full async support.' }] },
      });
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: makeError(ERROR_CODES.PARSE_ERROR, 'Invalid JSON'),
      });
    }
  };
}

export { TOOL_DEFINITION, SERVER_INFO, MCP_VERSION };
