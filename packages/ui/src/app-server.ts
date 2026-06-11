/**
 * app-server.ts — Comdr HTTP + WebSocket Server
 *
 * 提供 REST API 和 WebSocket 端点，用于未来 IDE 集成和远程调用。
 *
 * REST:
 *   POST /run           — 执行 agent 任务
 *   GET  /session/:id   — 获取会话状态
 *   GET  /health        — 健康检查
 *
 * WebSocket:
 *   ws://host:port/ws   — 流式推送 AgentEvent（逐事件推送 JSON）
 *
 * HTTP 解析使用 Node.js 内置 http 模块（零外部依赖）。
 * 此模块设计为独立运行。
 *
 * @agent Agent 5 — HTTP/WebSocket 入口
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IEngine, RunMode, SessionState } from '@comdr/core';
import { AGENT_EVENT, SYSTEM, RUN_MODE } from '@comdr/core';

/** Non-SSE mode: max events before truncation to prevent OOM on long sessions */
const MAX_EVENTS = 2000;
/** Non-SSE mode: max total serialized size (bytes) before truncation */
const MAX_RESPONSE_SIZE = 5_000_000;

// ============================================================================
// 类型
// ============================================================================

interface RunRequest {
  request: string;
  mode?: RunMode;
  sessionId?: string;
}

interface AppServerOptions {
  engine: IEngine;
  host?: string;
  port?: number;
}

// ============================================================================
// 工具
// ============================================================================

function jsonResponse(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ============================================================================
// 路由
// ============================================================================

function handleCORS(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return true;
  }
  return false;
}

/**
 * 启动 HTTP + WebSocket 服务器
 */
export function startAppServer(opts: AppServerOptions): () => void {
  const { engine, host = '127.0.0.1', port = SYSTEM.DEFAULT_PORT } = opts;

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (handleCORS(req, res)) return;

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // ===== GET /health =====
    if (req.method === 'GET' && path === '/health') {
      jsonResponse(res, 200, {
        status: 'ok',
        name: 'comdr-app-server',
        version: '0.1.0',
        uptime: process.uptime(),
      });
      return;
    }

    // ===== GET /session/:id =====
    if (req.method === 'GET' && path.startsWith('/session/')) {
      const sessionId = path.slice('/session/'.length);
      try {
        const session: SessionState = await engine.resumeSession(sessionId);
        jsonResponse(res, 200, session);
      } catch {
        jsonResponse(res, 404, { error: 'Session not found', sessionId });
      }
      return;
    }

    // ===== POST /run =====
    if (req.method === 'POST' && path === '/run') {
      const body = await readBody(req);

      let parsed: RunRequest;
      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      if (!parsed.request || typeof parsed.request !== 'string') {
        jsonResponse(res, 400, { error: 'Missing required field: request (string)' });
        return;
      }

      const mode: RunMode = parsed.mode ?? RUN_MODE.AGENT;
      const sessionId = parsed.sessionId ?? randomUUID();

      // 如果请求头要求流式响应，使用 SSE
      const acceptSSE = req.headers.accept?.includes('text/event-stream');

      if (acceptSSE) {
        // SSE 流式响应
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        try {
          for await (const event of engine.run(parsed.request, mode, sessionId)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          // ★ 引擎 finalize() 已发射 DONE 事件，不在此处伪造（避免覆盖真实 turns/tokensUsed）
        } catch (err) {
          res.write(`data: ${JSON.stringify({
            type: AGENT_EVENT.ERROR,
            code: 'STREAM_ERROR',
            message: String(err),
            recoverable: false,
          })}\n\n`);
        }
        res.end();
      } else {
        // 非流式：收集事件后返回（有上限保护）
        const events: unknown[] = [];
        let truncated = false;
        let totalSize = 0;
        try {
          for await (const event of engine.run(parsed.request, mode, sessionId)) {
            if (events.length >= MAX_EVENTS || totalSize >= MAX_RESPONSE_SIZE) {
              truncated = true;
              break;
            }
            events.push(event);
            totalSize += JSON.stringify(event).length;
          }
        } catch (err) {
          jsonResponse(res, 500, { error: 'Execution failed', details: String(err), events, truncated });
          return;
        }
        jsonResponse(res, 200, { sessionId, events, truncated });
      }
      return;
    }

    // ===== 404 =====
    jsonResponse(res, 404, { error: 'Not found', path });
  });

  // ★ WebSocket 端点 (/ws) 暂不启用。
  // 当前流式推送使用 SSE（Accept: text/event-stream 通过 POST /run）。
  // WebSocket 实现需要 ws 库做完整的帧解析（mask/unmask、fragmentation、close/ping/pong），
  // 见 https://github.com/websockets/ws —— 非当前优先级。

  server.listen(port, host, () => {
    const addr = server.address();
    if (addr && typeof addr !== 'string') {
      console.log(`[comdr-app-server] HTTP  → http://${host}:${port}`);
      console.log(`[comdr-app-server] SSE   → POST http://${host}:${port}/run (Accept: text/event-stream)`);
      console.log(`[comdr-app-server] Health → http://${host}:${port}/health`);
    }
  });

  // 返回 shutdown 函数
  return () => {
    server.close();
  };
}
