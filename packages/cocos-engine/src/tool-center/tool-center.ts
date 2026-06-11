// ============================================================
// ToolCenter — 文件 IPC 客户端
// Gateway ↔ Bridge 通过 temp/comdr/inbox/ + outbox/ 通信
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { normalizeSlash, nowISO, generateUuid, writeJsonAtomic } from '../foundation/value-kit.js';
import { CmdResult } from '../types.js';
import { ERR_CANCELLED, ERR_BR_BRIDGE_OFFLINE, ERR_BR_TASK_TIMEOUT } from '../errors/error-codes.js';
import { IPC_POLL_MS, IPC_TIMEOUT_MS, IPC_HEARTBEAT_MAX_AGE_MS } from '../foundation/constants.js';

// ===== 类型 =====

export interface ToolCenterTask {
  type: 'probe' | 'write' | 'open' | 'edit' | 'save';
  payload?: Record<string, unknown>;
}

export interface ToolCenterOptions {
  projectPath: string;
  timeoutMs?: number;
  pollMs?: number;
}

/** bridge.json 完整心跳包。与 document-state.ts:BridgeHeartbeat 同源，结构超集。 */
export interface BridgeHeartbeatInfo {
  schema: string;
  projectPath: string;
  root: string;
  inbox: string;
  processing: string;
  outbox: string;
  updatedAt: string;
  openDocument?: { kind: string; path: string };
  hasOpenDocument?: boolean;
  editorCapabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

const REQUEST_SCHEMA = 'Comdr.cocos-task-request.v1';
const RESULT_SCHEMA = 'Comdr.cocos-task-result.v1';

export class ToolCenter {
  private _projectPath: string;
  private _root: string;
  private _inbox: string;
  private _processing: string;
  private _outbox: string;
  private _timeoutMs: number;
  private _pollMs: number;
  private _online: boolean = false;
  private _healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ToolCenterOptions) {
    this._projectPath = normalizeSlash(options.projectPath);
    this._root = path.join(this._projectPath, 'temp', 'comdr');
    this._inbox = path.join(this._root, 'inbox');
    this._processing = path.join(this._root, 'processing');
    this._outbox = path.join(this._root, 'outbox');
    this._timeoutMs = options.timeoutMs || IPC_TIMEOUT_MS;
    this._pollMs = options.pollMs || IPC_POLL_MS;
  }

  // ===== 生命周期 =====

  async start(): Promise<boolean> {
    // 确保目录存在
    fs.mkdirSync(this._inbox, { recursive: true });
    fs.mkdirSync(this._processing, { recursive: true });
    fs.mkdirSync(this._outbox, { recursive: true });

    this._online = await this.health();
    return this._online;
  }

  destroy(): void {
    this.stopHealthChecks();
    this._online = false;
  }

  // ===== 提交任务 =====

  async submit(task: ToolCenterTask, signal?: AbortSignal): Promise<CmdResult> {
    if (!this._online) {
      const hb = await this.health();
      if (!hb) {
        return { ok: false, error: 'Bridge offline', errorCode: ERR_BR_BRIDGE_OFFLINE };
      }
      this._online = true;
    }

    const id = generateUuid();
    const request = {
      schema: REQUEST_SCHEMA,
      id,
      taskCard: task,
      createdAt: nowISO(),
    };

    // 原子写入 inbox（复用 value-kit 的标准模式）
    const inboxPath = path.join(this._inbox, `${id}.json`);
    writeJsonAtomic(inboxPath, request, true);

    // 轮询结果
    const startTime = Date.now();
    const outboxPath = path.join(this._outbox, `${id}.json`);

    while (Date.now() - startTime < this._timeoutMs) {
      if (signal?.aborted) {
        try { fs.rmSync(inboxPath, { force: true }); } catch { /* ignore */ }
        return { ok: false, error: 'Cancelled', errorCode: ERR_CANCELLED };
      }
      await sleep(this._pollMs);

      if (!fs.existsSync(outboxPath)) continue;

      // 读取结果（重试解析防止部分写入）
      let lastParseError = '';
      for (let retry = 0; retry < 3; retry++) {
        try {
          const raw = fs.readFileSync(outboxPath, 'utf8').replace(/^﻿/, '');
          const result = JSON.parse(raw);

          if (result.schema !== RESULT_SCHEMA) {
            return {
              ok: false,
              error: `Invalid result schema: ${result.schema}`,
              errorCode: 'BR_INVALID_RESPONSE',
            };
          }

          // 清理文件
          try { fs.rmSync(outboxPath, { force: true }); } catch { /* ignore */ }
          try { fs.rmSync(inboxPath, { force: true }); } catch { /* ignore */ }

          // Bridge 返回 { ok, result, error, ... }，实际操作结果在 result 中
          const bridgeOk = result.ok === true;
          // Bridge 成功但缺 result 字段 → 编码异常，当作失败处理
          if (bridgeOk && !result.result) {
            process.stderr.write(`[comdr] Bridge response missing 'result' field for task ${id}\n`);
            return {
              ok: false,
              type: task.type,
              error: 'Bridge response missing result field',
              errorCode: 'BR_INVALID_RESPONSE',
            };
          }
          const inner = (result.result as Record<string, unknown>) || {};
          // 如果 Bridge 层成功，取内层结果；否则 Bridge 本身失败
          const actualOk = bridgeOk ? (inner.ok !== false) : false;
          return {
            ok: actualOk,
            type: task.type,
            data: bridgeOk ? result.result : undefined,
            error: bridgeOk ? (inner.error as string) : (result.error as string),
            errorCode: bridgeOk
              ? ((inner.errorCode || inner.code) as string)
              : (result.errorCode as string),
          };
        } catch (e) {
          lastParseError = (e as Error).message;
          if (retry < 2) await sleep(50);
        }
      }
      process.stderr.write(`[comdr] result parse failed after 3 retries for ${id}: ${lastParseError}\n`);
    }

    // 超时
    try { fs.rmSync(inboxPath, { force: true }); } catch { /* ignore */ }
    return {
      ok: false,
      error: `Task timeout after ${this._timeoutMs}ms: ${id}`,
      errorCode: ERR_BR_TASK_TIMEOUT,
    };
  }

  // ===== 健康检查 =====

  async health(): Promise<boolean> {
    const info = this.getBridgeInfo();
    if (!info) return false;

    const age = Date.now() - new Date(info.updatedAt).getTime();
    return age < IPC_HEARTBEAT_MAX_AGE_MS;
  }

  getBridgeInfo(): BridgeHeartbeatInfo | null {
    const bp = path.join(this._root, 'bridge.json');
    if (!fs.existsSync(bp)) return null;

    try {
      const raw = fs.readFileSync(bp, 'utf8').replace(/^﻿/, '');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  getCapabilities(): Record<string, unknown> | null {
    const info = this.getBridgeInfo();
    return info?.editorCapabilities || null;
  }

  get isOnline(): boolean {
    return this._online;
  }

  startHealthChecks(intervalMs: number = 15_000): void {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(async () => {
      this._online = await this.health();
    }, intervalMs);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  stopHealthChecks(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
