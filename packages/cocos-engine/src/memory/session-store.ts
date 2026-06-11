// ============================================================
// SessionStore — 跨调用会话持久化
// 存储位置: ~/.comdr/sessions/{id}.json
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { readJsonUtf8, writeJsonAtomic, nowISO } from '../foundation/value-kit.js';
import { SESSION_RECENT_CREATIONS } from '../foundation/constants.js';

export interface CreatedAsset {
  path: string;
  uuid: string;
  purpose: string;
  at: string;
}

/** Commander 跨调用恢复所需的完整对话状态 */
export interface CommanderSnapshot {
  messages: Array<{ role: string; content: string }>;
  tempIdMappings: Record<string, string>;
  knownNodes: Record<string, string>;
  probeQueries: Record<string, number>;
  turn: number;
}

export interface Session {
  sessionId: string;
  projectPath: string;
  createdAt: string;
  modifiedAt: string;
  createdAssets: CreatedAsset[];
  modifiedAssets: string[];
  openDocument: { kind: string; path: string } | null;
  /** Commander ask 时的对话快照，下次调用恢复后可继续对话 */
  commanderSnapshot?: CommanderSnapshot;
}

const SESSION_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.comdr',
  'sessions'
);

const OLD_SESSION_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.cmdr',
  'sessions'
);

/** 解析会话存储目录 */
function sessionPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function oldSessionPath(sessionId: string): string {
  return path.join(OLD_SESSION_DIR, `${sessionId}.json`);
}

/** 加载会话，不存在则创建新的 */
export function loadSession(sessionId: string): Session {
  const filePath = sessionPath(sessionId);
  let data = readJsonUtf8(filePath) as Session | null;

  // 迁移：新路径无会话时尝试旧路径 (cmdr → comdr 重命名兼容)
  if (!data) {
    const oldPath = oldSessionPath(sessionId);
    const oldData = readJsonUtf8(oldPath) as Session | null;
    if (oldData && oldData.sessionId === sessionId) {
      data = oldData;
      // 写入新位置
      fs.mkdirSync(SESSION_DIR, { recursive: true });
      writeJsonAtomic(filePath, data, true);
    }
  }

  if (data && data.sessionId === sessionId) {
    return data;
  }
  return {
    sessionId,
    projectPath: '',
    createdAt: nowISO(),
    modifiedAt: nowISO(),
    createdAssets: [],
    modifiedAssets: [],
    openDocument: null,
  };
}

/** 保存会话到磁盘 */
export function saveSession(session: Session): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  session.modifiedAt = nowISO();
  const filePath = sessionPath(session.sessionId);
  writeJsonAtomic(filePath, session, true);
}

/** 记录创建的资产 */
export function recordCreated(
  session: Session,
  assetPath: string,
  uuid: string,
  purpose: string
): void {
  session.createdAssets.push({
    path: assetPath,
    uuid,
    purpose,
    at: nowISO(),
  });
  session.modifiedAt = nowISO();
}

/** 记录修改的资产 */
export function recordModified(session: Session, assetPath: string): void {
  if (!session.modifiedAssets.includes(assetPath)) {
    session.modifiedAssets.push(assetPath);
  }
  session.modifiedAt = nowISO();
}

/** 记录打开的文档 */
export function recordOpenDocument(session: Session, kind: string, filePath: string): void {
  session.openDocument = { kind, path: filePath };
  session.modifiedAt = nowISO();
}

/** 生成会话摘要（给 Commander 用） */
export function buildSummary(session: Session): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    createdCount: session.createdAssets.length,
    modifiedCount: session.modifiedAssets.length,
    openDocument: session.openDocument,
    recentCreations: session.createdAssets.slice(-SESSION_RECENT_CREATIONS).map((a) => ({
      path: a.path,
      purpose: a.purpose,
    })),
  };
}
