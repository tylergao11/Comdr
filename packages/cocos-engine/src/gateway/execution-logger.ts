// ============================================================
// ExecutionLogger — 执行事件 NDJSON 日志写入器
// 追加模式写 <project>/temp/comdr/execution-log.jsonl
// Overlay 被动轮询该文件以实时显示执行数据流
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { ExecutionEvent } from '../types.js';
import { EXECUTION_LOG_MAX_BYTES } from '../foundation/constants.js';

/** 超过上限时保留最末的行数 */
const KEEP_LINES = 500;

export class ExecutionLogger {
  private _logPath: string;
  private _dirEnsured = false;
  private _writeCount = 0;

  constructor(projectPath: string) {
    this._logPath = path.join(projectPath, 'temp', 'comdr', 'execution-log.jsonl');
  }

  /** 追加一行 JSON 事件到日志文件，写失败静默（最佳努力原则）。
   *  每 20 次写入检查一次文件大小，超过 1MB 自动保留最末 500 行。 */
  write(event: ExecutionEvent): void {
    if (!this._dirEnsured) {
      fs.mkdirSync(path.dirname(this._logPath), { recursive: true });
      this._dirEnsured = true;
    }
    try {
      fs.appendFileSync(this._logPath, JSON.stringify(event) + '\n', 'utf8');
    } catch (e) {
      process.stderr.write(`[comdr] exec log write failed: ${(e as Error).message}\n`);
      return;
    }

    // 日志旋转：每 N 次写入后检查，超过阈值则截断保留尾部
    if (++this._writeCount % 20 === 0) {
      try {
        const stat = fs.statSync(this._logPath);
        if (stat.size > EXECUTION_LOG_MAX_BYTES) {
          const lines = fs.readFileSync(this._logPath, 'utf8').split('\n').filter(Boolean);
          if (lines.length > KEEP_LINES) {
            const kept = lines.slice(-KEEP_LINES);
            fs.writeFileSync(this._logPath, kept.join('\n') + '\n', 'utf8');
            process.stderr.write(`[comdr] execution-log.jsonl rotated: ${lines.length} → ${KEEP_LINES} lines\n`);
          }
        }
      } catch (e) {
        process.stderr.write(`[comdr] execution-log rotation failed: ${(e as Error).message}\n`);
      }
    }
  }
}
