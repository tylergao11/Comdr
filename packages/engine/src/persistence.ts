/**
 * persistence.ts — 会话持久化（JSON 文件存储）
 *
 * 存储路径: {projectPath}/temp/comdr/sessions/{sessionId}.json
 *
 * 职责:
 *   1. save()     — 保存会话状态到文件
 *   2. load()     — 从文件恢复会话状态
 *   3. list()     — 列出所有已保存会话
 *   4. delete()   — 删除会话文件
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import {
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SessionState } from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';
import { summarizeToolOutput } from './smart-truncate.js';

/** 会话文件最大字节数（≈5MB），超过则压缩保存（剔除旧 tool result 内容） */
const MAX_SESSION_FILE_SIZE = 5_000_000;

// ============================================================================
// §1 SessionStore 类
// ============================================================================

export class SessionStore {
  private readonly sessionsDir: string;

  constructor(projectPath: string) {
    this.sessionsDir = join(projectPath, 'temp', 'comdr', 'sessions');
  }

  // --------------------------------------------------------------------------
  // save() — 保存会话
  // --------------------------------------------------------------------------

  /**
   * 保存会话状态到 JSON 文件。
   *
   * ★ 大小保护：超过 MAX_SESSION_FILE_SIZE 时裁剪旧 tool result 内容，
   *   仅保留最近 TOOL_RESULT_KEEP_COUNT 条完整输出。
   */
  save(session: SessionState): void {
    this.ensureDir();

    // 更新时间戳
    session.updatedAt = new Date().toISOString();

    let json = JSON.stringify(session, null, 2);
    if (json.length > MAX_SESSION_FILE_SIZE && session.messages.length > 0) {
      // 裁剪旧的 tool result 内容：保留最近 N 条完整输出
      const KEEP = 20;
      const messages = session.messages;
      let toolResultCount = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role === 'tool') {
          toolResultCount++;
          if (toolResultCount > KEEP && msg.content && msg.content.length > 200) {
            msg.content = summarizeToolOutput(msg.content, undefined, 200);
          }
        }
      }
      json = JSON.stringify(session, null, 2);
      if (json.length > MAX_SESSION_FILE_SIZE) {
        // 依然过大 → 写警告但不阻止保存
        console.warn(
          `[Comdr] Session file still ${(json.length / 1_000_000).toFixed(1)}MB after trimming. ` +
          'Consider reducing turn count or token budget.',
        );
      }
    }

    const filePath = this.sessionPath(session.id);
    writeFileSync(filePath, json, 'utf-8');
  }

  // --------------------------------------------------------------------------
  // load() — 恢复会话
  // --------------------------------------------------------------------------

  /**
   * 从 JSON 文件恢复会话状态
   *
   * @returns SessionState，文件不存在或损坏时返回 null
   */
  load(sessionId: string): SessionState | null {
    const filePath = this.sessionPath(sessionId);

    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const session = JSON.parse(raw) as SessionState;

      // ★ 基础校验：确保必填字段存在且类型正确
      if (
        !session.id ||
        !Array.isArray(session.messages) ||
        !Array.isArray(session.stateWindow) ||
        !Array.isArray(session.intentWindow)
      ) {
        return null;
      }

      // ★ 校验 stateWindow 元素有必填字段
      if (session.stateWindow.some((e) => !e?.key || !e?.text)) {
        return null;
      }

      // ★ 校验 intentWindow 元素有必填字段
      if (session.intentWindow.some((e) => !e?.key || !e?.why)) {
        return null;
      }

      // 确保运行时字段有默认值
      session.turn = typeof session.turn === 'number' ? session.turn : 0;
      session.tokensUsed = typeof session.tokensUsed === 'number' ? session.tokensUsed : 0;
      session.currentInput = typeof session.currentInput === 'string' ? session.currentInput : '';
      session.outcome = session.outcome ?? null;
      // ★ tempIdMappings 必须是对象（JSON 反序列化后可能是 null）
      session.tempIdMappings = (session.tempIdMappings && typeof session.tempIdMappings === 'object')
        ? session.tempIdMappings
        : {};

      return session;
    } catch {
      // JSON 解析失败
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // list() — 列出所有会话
  // --------------------------------------------------------------------------

  /**
   * 列出所有已保存的会话 ID
   *
   * @returns 会话 ID 数组，按修改时间降序（最新在前）
   */
  list(): string[] {
    if (!existsSync(this.sessionsDir)) return [];

    try {
      const entries = readdirSync(this.sessionsDir);
      const sessionFiles = entries
        .filter((e) => e.endsWith('.json'))
        .flatMap((e) => {
          try {
            const mtimeMs = statSync(join(this.sessionsDir, e)).mtimeMs;
            return [{ id: e.replace('.json', ''), mtimeMs }];
          } catch {
            // TOCTOU: 文件可能在 readdir 和 stat 之间被删除
            return [];
          }
        });

      // 按修改时间降序排列
      sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return sessionFiles.map((s) => s.id);
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // delete() — 删除会话
  // --------------------------------------------------------------------------

  /**
   * 删除指定会话的持久化文件
   */
  delete(sessionId: string): void {
    const filePath = this.sessionPath(sessionId);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // 删除失败 → 静默忽略
    }
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 跨会话情景记忆文件路径
   */
  getEpisodicPath(): string {
    return join(this.sessionsDir, 'episodic.json');
  }

  /**
   * 加载跨会话情景记忆（JSON 字符串）
   * @returns 序列化的 episodic memory 数据，不存在或损坏时返回 null
   */
  loadEpisodic(): { episodes: string; reflections: string } | null {
    const filePath = this.getEpisodicPath();
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as { episodes: string; reflections: string };
    } catch {
      // 兼容旧格式：纯 JSON array → 视为 episodes
      try {
        const raw = readFileSync(filePath, 'utf-8');
        return { episodes: raw, reflections: '[]' };
      } catch {
        return null;
      }
    }
  }

  /**
   * 保存跨会话情景记忆到磁盘（含 episodes + reflections）
   */
  saveEpisodic(data: { episodes: string; reflections: string }): void {
    this.ensureDir();
    try {
      writeFileSync(
        this.getEpisodicPath(),
        JSON.stringify(data, null, 2),
        'utf-8',
      );
    } catch {
      // 写入失败 → 静默降级
    }
  }

  // --------------------------------------------------------------------------
  // Semantic Memory 持久化
  // --------------------------------------------------------------------------

  /** Semantic Memory 文件路径 */
  getSemanticPath(): string {
    return join(this.sessionsDir, 'semantic.json');
  }

  loadSemantic(): string | null {
    const p = this.getSemanticPath();
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf-8'); } catch { return null; }
  }

  saveSemantic(data: string): void {
    this.ensureDir();
    try { writeFileSync(this.getSemanticPath(), data, 'utf-8'); } catch { /* 静默降级 */ }
  }

  /**
   * 会话 ID → 文件路径
   */
  private sessionPath(sessionId: string): string {
    // 防止路径遍历攻击
    const safe = sessionId.replace(/[<>:"/\\|?*]/g, '_');
    return join(this.sessionsDir, `${safe}.json`);
  }

  /**
   * 确保会话目录存在
   */
  private ensureDir(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
  }
}

// ============================================================================
// §2 工厂函数
// ============================================================================

/**
 * 创建会话存储实例
 */
export function createSessionStore(projectPath: string): SessionStore {
  return new SessionStore(projectPath);
}
