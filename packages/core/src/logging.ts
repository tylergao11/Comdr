/**
 * logging.ts — JSONL 事件日志 + Token 统计
 *
 * 输出路径:
 *   JSONL 事件流  → {projectPath}/temp/comdr/execution-{date}.jsonl
 *   Token 统计    → {projectPath}/temp/comdr/latest-tokens.json
 *
 * 日志旋转: 文件 >500KB → 保留末 1000 行
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

import type { AgentEvent, TokenUsage } from './types.js';
import { SYSTEM } from './types.js';

// ============================================================================
// §1 路径工具
// ============================================================================

/**
 * 格式化日期为 YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 确保日志目录存在
 */
function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

// ============================================================================
// §2 EventLogger 类
// ============================================================================

export class EventLogger {
  private readonly logDir: string;
  private logPath: string;
  private tokenPath: string;

  constructor(projectPath: string) {
    this.logDir = pathJoin(projectPath, 'temp', 'comdr');
    ensureDir(this.logDir);

    const dateStr = formatDate(new Date());
    this.logPath = pathJoin(this.logDir, `execution-${dateStr}.jsonl`);
    this.tokenPath = pathJoin(this.logDir, 'latest-tokens.json');
  }

  // --------------------------------------------------------------------------
  // 事件写入
  // --------------------------------------------------------------------------

  /**
   * 写入一个 AgentEvent（追加一行 JSON）
   */
  log(event: AgentEvent): void {
    this.rotateIfNeeded();
    const line = JSON.stringify(event) + '\n';
    appendFileSync(this.logPath, line, 'utf-8');
  }

  /**
   * 写入 token 统计（覆盖 latest-tokens.json）
   */
  logTokens(usage: TokenUsage): void {
    ensureDir(this.logDir);
    writeFileSync(this.tokenPath, JSON.stringify(usage, null, 2), 'utf-8');
  }

  // --------------------------------------------------------------------------
  // 日志旋转
  // --------------------------------------------------------------------------

  /**
   * 日志文件超过 LOG_ROTATION_SIZE → 保留末 1000 行
   */
  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.logPath).size;
    } catch {
      return; // 文件不存在
    }

    if (size <= SYSTEM.LOG_ROTATION_SIZE) return;

    // 读取末 LOG_RETAIN_LINES 行
    const content = readFileSync(this.logPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    const kept = lines.slice(-SYSTEM.LOG_RETAIN_LINES);

    // 加标记行
    kept.unshift(
      // ★ 用 `__comdr_meta` type 避免污染 AgentEvent 可辨识联合类型
      JSON.stringify({
        type: '__comdr_meta',
        event: 'log_rotation',
        originalLines: lines.length,
        keptLines: kept.length,
        timestamp: new Date().toISOString(),
      }),
    );

    writeFileSync(this.logPath, kept.join('\n') + '\n', 'utf-8');
  }

  // --------------------------------------------------------------------------
  // 读取接口
  // --------------------------------------------------------------------------

  /**
   * 返回当前日志文件路径
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * 返回 token 统计文件路径
   */
  getTokenPath(): string {
    return this.tokenPath;
  }

  /**
   * 读取最新的 token 统计
   */
  readLatestTokens(): TokenUsage | null {
    try {
      const raw = readFileSync(this.tokenPath, 'utf-8');
      // ★ 读取的是本程序写入的 latest-tokens.json → 信任格式
      return JSON.parse(raw) as TokenUsage;
    } catch {
      return null;
    }
  }

  /**
   * 返回指定日期的日志路径（不保证文件存在）
   */
  getLogPathForDate(date: Date): string {
    return `${this.logDir}/execution-${formatDate(date)}.jsonl`;
  }
}

// ============================================================================
// §3 工厂函数
// ============================================================================

/**
 * 创建 EventLogger 实例并绑定到指定 projectPath
 */
export function createEventLogger(projectPath: string): EventLogger {
  return new EventLogger(projectPath);
}
