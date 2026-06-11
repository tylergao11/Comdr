/**
 * mcp-client.ts — MCP Server 连接管理
 *
 * 根据 config.mcpServers 启动子进程，通过 stdio JSON-RPC 通信。
 *
 * MCP 协议层:
 *   1. initialize  — 握手，交换能力
 *   2. tools/list  — 获取 MCP server 暴露的工具
 *   3. tools/call  — 调用 MCP 工具
 *   4. shutdown    — 优雅关闭
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { validateJSONSchemaProperty, SERVER_STATUS, TOOL_PERMISSION, SYSTEM } from '@comdr/core';
import type { ToolDefinition, MCPServerConfig, JSONSchema, JSONSchemaProperty, MCPServerStatus } from '@comdr/core/types';

// ============================================================================
// §1 类型定义
// ============================================================================

/**
 * MCP JSON-RPC 消息
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult {
  ok: boolean;
  content: string | null;
  errorCategory?: string;
}

// ============================================================================
// §2 MCPClient 类
// ============================================================================

export class MCPClient {
  private readonly configs: MCPServerConfig[];
  /** server name → config */
  private readonly configMap: Map<string, MCPServerConfig> = new Map();
  /** server name → process */
  private processes: Map<string, ChildProcess> = new Map();
  /** server name → request ID counter */
  private requestIds: Map<string, number> = new Map();
  /** server name → pending requests */
  private pending: Map<string, Map<number, (response: JsonRpcResponse) => void>> = new Map();
  /** server name → accumulated stdout buffer */
  private buffers: Map<string, string> = new Map();
  /** server name → status */
  private statuses: Map<string, MCPServerStatus> = new Map();
  /** server name → tool definitions */
  private toolDefs: Map<string, ToolDefinition[]> = new Map();
  /** server name → connection start time (ms) */
  private startTimes: Map<string, number> = new Map();

  private started = false;

  constructor(configs: MCPServerConfig[]) {
    this.configs = configs;

    for (const cfg of configs) {
      this.configMap.set(cfg.name, cfg);
      this.statuses.set(cfg.name, {
        name: cfg.name,
        status: SERVER_STATUS.OFFLINE,
        transport: 'stdio',
        tools: [],
      });
      this.buffers.set(cfg.name, '');
      this.pending.set(cfg.name, new Map());
      this.requestIds.set(cfg.name, 1);
      this.toolDefs.set(cfg.name, []);
    }
  }

  // --------------------------------------------------------------------------
  // startAll() — 启动所有 MCP Server
  // --------------------------------------------------------------------------

  /**
   * 启动所有配置的 MCP Server 并完成初始化握手
   *
   * @returns 成功启动的 server 数量
   */
  async startAll(): Promise<number> {
    if (this.started) return this.processes.size;
    this.started = true;

    const results = await Promise.allSettled(
      this.configs.map((cfg) => this.startOne(cfg)),
    );

    return results.filter((r) => r.status === 'fulfilled').length;
  }

  /**
   * 启动单个 MCP Server
   */
  private async startOne(cfg: MCPServerConfig): Promise<void> {
    const status = this.statuses.get(cfg.name)!;
    status.status = SERVER_STATUS.CONNECTING;

    try {
      const proc = spawn(cfg.command, cfg.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cfg.env ? { ...process.env, ...cfg.env } : process.env,
      });

      proc.on('exit', (code) => {
        status.status = code === 0 ? SERVER_STATUS.OFFLINE : SERVER_STATUS.ERROR;
        status.error = code !== 0 ? `Exit code: ${code}` : undefined;
        status.pid = undefined;
      });

      proc.on('error', (err) => {
        status.status = SERVER_STATUS.ERROR;
        status.error = err.message;
      });

      // stdout 数据收集（带 1MB 上限防 OOM）
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          const buf = this.buffers.get(cfg.name) ?? '';
          // ★ 超过 1MB 上限 → 断开连接，防止恶意/故障 server 撑爆内存
          if (buf.length > 1_000_000) {
            status.status = SERVER_STATUS.ERROR;
            status.error = `stdout buffer exceeded 1MB limit (${buf.length} bytes). Disconnecting.`;
            proc.kill();
            return;
          }
          const newBuf = buf + chunk.toString('utf-8');
          this.buffers.set(cfg.name, newBuf);
          this.tryParseResponses(cfg.name);
        });
      }

      // stderr 日志——记录到 logger，不静默丢弃
      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8').trim();
          if (text) {
            console.warn(`[Comdr] MCP [${cfg.name}] stderr: ${text}`);
          }
        });
      }

      this.processes.set(cfg.name, proc);
      this.startTimes.set(cfg.name, Date.now());
      status.pid = proc.pid;
      status.status = SERVER_STATUS.CONNECTED;
      status.uptime = 0;
      status.error = undefined;

      // ★ MCP 握手: initialize
      const initResult = await this.sendRequest(cfg.name, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'comdr',
          version: '0.1.0',
        },
      });

      if (initResult.error) {
        throw new Error(`MCP initialize failed: ${initResult.error.message}`);
      }

      // ★ 获取工具列表
      const toolsResult = await this.sendRequest(cfg.name, 'tools/list', {});
      if (toolsResult.result) {
        const tools = (toolsResult.result as { tools?: unknown[] }).tools ?? [];
        const defs = tools.map((t: unknown) => this.parseMCPTool(t, cfg.name));
        this.toolDefs.set(cfg.name, defs);
        status.tools = defs.map((d) => d.name);
      }
    } catch (err) {
      status.status = SERVER_STATUS.ERROR;
      status.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // callTool() — 调用 MCP 工具
  // --------------------------------------------------------------------------

  /**
   * 调用 MCP Server 上的工具
   *
   * @param toolName  格式: "mcp__<serverName>__<toolName>"
   * @param args      工具参数
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const parsed = this.parseMCPToolName(toolName);
    if (!parsed) {
      return {
        ok: false,
        content: null,
        errorCategory: 'schema_invalid',
      };
    }

    const { serverName, tool } = parsed;
    const proc = this.processes.get(serverName);
    if (!proc) {
      return {
        ok: false,
        content: `MCP server '${serverName}' not running`,
        errorCategory: 'execution_error',
      };
    }

    try {
      const response = await this.sendRequest(serverName, 'tools/call', {
        name: tool,
        arguments: args,
      });

      if (response.error) {
        return {
          ok: false,
          content: response.error.message,
          errorCategory: 'execution_error',
        };
      }

      return {
        ok: true,
        content: this.extractToolContent(response.result),
      };
    } catch (err) {
      return {
        ok: false,
        content: err instanceof Error ? err.message : String(err),
        errorCategory: 'execution_error',
      };
    }
  }

  // --------------------------------------------------------------------------
  // getTools() — 获取 MCP 工具定义
  // --------------------------------------------------------------------------

  /**
   * 获取所有 MCP Server 提供的工具定义。
   * 工具名格式: "mcp__<serverName>__<toolName>"
   *
   * 描述增强:
   *   [MCP:serverName] — 来源标记
   *   [hint]            — 能力提示（延迟、依赖、适用场景），来自 config
   */
  getTools(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const [serverName, defs] of this.toolDefs) {
      const cfg = this.configMap.get(serverName);
      const hint = cfg?.hint ? ` 【${cfg.hint}】` : '';
      for (const def of defs) {
        result.push({
          ...def,
          name: `mcp__${serverName}__${def.name}`,
          description: `[MCP:${serverName}]${hint} ${def.description}`,
        });
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // getStatuses() — 获取连接状态
  // --------------------------------------------------------------------------

  /**
   * 获取所有 MCP Server 的连接状态
   */
  getStatuses(): MCPServerStatus[] {
    const now = Date.now();
    for (const [name, status] of this.statuses) {
      const startTime = this.startTimes.get(name);
      if (status.status === SERVER_STATUS.CONNECTED && startTime !== undefined) {
        status.uptime = Math.floor((now - startTime) / 1000);
      }
    }
    return [...this.statuses.values()];
  }

  // --------------------------------------------------------------------------
  // shutdown() — 优雅关闭
  // --------------------------------------------------------------------------

  /**
   * 关闭所有 MCP Server 连接
   */
  async shutdown(): Promise<void> {
    for (const [name, proc] of this.processes) {
      try {
        // 发送 shutdown 通知
        this.sendNotification(name, 'shutdown');
        // 等待 500ms 后强制 kill
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve();
          }, 500);
          proc.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        proc.kill('SIGKILL');
      }
    }
    this.processes.clear();
    this.started = false;
  }

  // --------------------------------------------------------------------------
  // 内部: JSON-RPC 通信
  // --------------------------------------------------------------------------

  /**
   * 发送 JSON-RPC 请求并等待响应
   */
  private sendRequest(
    serverName: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const proc = this.processes.get(serverName);
    if (!proc || !proc.stdin) {
      return Promise.resolve({
        jsonrpc: '2.0',
        id: 0,
        error: { code: -1, message: 'Server not connected' },
      });
    }

    const id = this.requestIds.get(serverName) ?? 1;
    this.requestIds.set(serverName, id + 1);

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const pending = this.pending.get(serverName)!;

      // 超时 30s
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, SYSTEM.MCP_DEFAULT_TIMEOUT_MS);

      // ★ 注册 resolver（自动清除超时）
      pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });

      try {
        if (proc.stdin) {
          proc.stdin.write(JSON.stringify(request) + '\n');
        } else {
          reject(new Error('MCP process stdin is not available'));
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * 发送 JSON-RPC 通知（无需响应）
   */
  private sendNotification(
    serverName: string,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const proc = this.processes.get(serverName);
    if (!proc?.stdin) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      proc.stdin.write(JSON.stringify(notification) + '\n');
    } catch {
      // 静默失败
    }
  }

  /**
   * 尝试从缓冲区解析 JSON-RPC 响应
   */
  private tryParseResponses(serverName: string): void {
    const buf = this.buffers.get(serverName) ?? '';
    const lines = buf.split('\n');
    // 最后一行可能不完整，保留在缓冲区
    this.buffers.set(serverName, lines.pop() ?? '');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id !== undefined) {
          const pending = this.pending.get(serverName);
          const resolver = pending?.get(response.id);
          if (resolver) {
            pending!.delete(response.id);
            resolver(response);
          }
        }
      } catch {
        // 非 JSON 行 → 跳过
      }
    }
  }

  /**
   * 从 MCP tools/list 结果解析 ToolDefinition
   */
  private parseMCPTool(raw: unknown, _serverName: string): ToolDefinition {
    const t = raw as Record<string, unknown> | null;
    const name = typeof t?.name === 'string' ? t.name : 'unknown';

    // MCP tool 的 inputSchema 映射到 JSONSchema
    const inputSchema = (t?.inputSchema ?? {}) as Record<string, unknown>;
    // ★ 使用共享验证器转换 MCP inputSchema properties → JSONSchemaProperty
    const rawProps = (inputSchema.properties ?? {}) as Record<string, unknown>;
    const convertedProps: Record<string, JSONSchemaProperty> = {};
    for (const [key, prop] of Object.entries(rawProps)) {
      const validated = validateJSONSchemaProperty(prop);
      if (validated) {
        convertedProps[key] = validated;
      }
    }

    const parameters: JSONSchema = {
      type: 'object',
      properties: convertedProps,
    };
    const required = inputSchema.required;
    if (Array.isArray(required) && required.every((v): v is string => typeof v === 'string') && required.length > 0) {
      parameters.required = required;
    }

    return {
      name,
      description: typeof t?.description === 'string' ? t.description : '',
      parameters,
      permission: TOOL_PERMISSION.REQUIRES_APPROVAL,
      timeoutMs: SYSTEM.MCP_DEFAULT_TIMEOUT_MS,
    };
  }

  /**
   * 解析工具名 "mcp__<server>__<tool>" 格式。
   *
   * 解析策略: 以 "__" 分割 → 首段必须是 "mcp"，末段是 tool 名，
   * 中间所有段用 "__" 拼接还原为 server 名。
   *
   * 示例:
   *   "mcp__comdr_engine__file_read" → server="comdr_engine", tool="file_read"
   *   "mcp__github__search_code"     → server="github",       tool="search_code"
   *
   * 注意: server 名可以含下划线，但不能以 "__" 开头或结尾。
   *   含 "__" 的 server 名（如 my__server）会产生歧义，禁止使用。
   */
  private parseMCPToolName(
    toolName: string,
  ): { serverName: string; tool: string } | null {
    const parts = toolName.split('__');
    // 至少需要 3 段: mcp, server, tool
    if (parts.length < 3 || parts[0] !== 'mcp') return null;

    // 使用 .at(-1) 替代 [parts.length - 1]!: 空数组时返回 undefined，不会产生 undefined!
    const tool = parts.at(-1);
    // server 名 = 中间所有段用 "__" 连接
    const serverName = parts.slice(1, -1).join('__');

    if (!serverName || !tool) return null;
    return { serverName, tool };
  }

  /**
   * 从 MCP tools/call 响应中提取文本内容
   */
  private extractToolContent(result: unknown): string | null {
    if (typeof result === 'string') return result;
    if (!result || typeof result !== 'object') return null;

    const r = result as Record<string, unknown>;
    // MCP content array: [{ type: 'text', text: '...' }, { type: 'image', ... }, ...]
    if (Array.isArray(r.content)) {
      const parts: string[] = [];
      for (const c of r.content as Array<Record<string, unknown>>) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        } else if (c.type === 'image' && typeof c.data === 'string') {
          // ★ 保留 image——描述 MIME 类型和数据长度，不丢弃
          const mime = typeof c.mimeType === 'string' ? c.mimeType : 'image';
          parts.push(`[${mime} data: ${c.data.length} bytes]`);
        } else if (c.type === 'resource' || c.type === 'embedded_resource') {
          // ★ 保留 resource URI 引用
          const uri = typeof c.uri === 'string' ? c.uri : 'unknown';
          // ★ 截断到 200 字符：MCP resource 文本可能极大（整个文件内容），
          //    prompt 中只保留开头片段作为上下文指纹，完整内容通过后续工具调用获取。
          const text = typeof c.text === 'string' ? `: ${c.text.slice(0, 200)}` : '';
          parts.push(`[resource: ${uri}${text}]`);
        } else if (c.type) {
          // ★ 未知类型保留类型名，不静默丢弃
          parts.push(`[${c.type}]`);
        }
      }
      return parts.join('\n') || null;
    }

    return JSON.stringify(r);
  }
}

// ============================================================================
// §3 工厂函数
// ============================================================================

/**
 * 创建 MCP 客户端实例
 */
export function createMCPClient(configs: MCPServerConfig[]): MCPClient {
  return new MCPClient(configs);
}

// ============================================================================
// §4 辅助
// ============================================================================

