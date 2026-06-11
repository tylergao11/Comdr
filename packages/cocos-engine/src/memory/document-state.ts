// ============================================================
// DocumentState — 当前打开的文档跟踪，从 Bridge 心跳同步
// ============================================================

import { BUFFER_EDIT_HISTORY } from '../foundation/constants.js';

export const DOCUMENT_KINDS = {
  SCENE: 'scene',
  PREFAB: 'prefab',
  NONE: 'none',
} as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[keyof typeof DOCUMENT_KINDS];

export interface DocumentStateInfo {
  kind: DocumentKind;
  dbUrl: string | null;
  path: string | null;
  assetUuid: string | null;
  rootUuid: string | null;
  name: string | null;
}

/** 与 tool-center.ts:BridgeHeartbeatInfo 同源 bridge.json，保持兼容 */
export interface BridgeHeartbeatDocument {
  kind?: string;
  path?: string;
  dbUrl?: string;
  assetUuid?: string;
  rootNodeUuid?: string;
  name?: string;
}

/** 与 tool-center.ts:BridgeHeartbeatInfo 同源 bridge.json，保持兼容 */
export interface BridgeHeartbeat {
  openDocument?: BridgeHeartbeatDocument;
  hasOpenDocument?: boolean;
  currentScene?: Record<string, unknown>;
}

const EMPTY_STATE: DocumentStateInfo = {
  kind: 'none',
  dbUrl: null,
  path: null,
  assetUuid: null,
  rootUuid: null,
  name: null,
};

export class DocumentState {
  private _current: DocumentStateInfo = { ...EMPTY_STATE };
  private _history: DocumentStateInfo[] = [];

  openScene(dbUrl: string, assetUuid?: string, rootUuid?: string, name?: string): void {
    this._pushHistory();
    this._current = {
      kind: 'scene',
      dbUrl,
      path: null,
      assetUuid: assetUuid || null,
      rootUuid: rootUuid || null,
      name: name || null,
    };
  }

  openPrefab(dbUrl: string, assetUuid?: string, rootUuid?: string, name?: string): void {
    this._pushHistory();
    this._current = {
      kind: 'prefab',
      dbUrl,
      path: null,
      assetUuid: assetUuid || null,
      rootUuid: rootUuid || null,
      name: name || null,
    };
  }

  close(): void {
    this._pushHistory();
    this._current = { ...EMPTY_STATE };
  }

  getCurrent(): Readonly<DocumentStateInfo> {
    return this._current;
  }

  isEditingScene(): boolean {
    return this._current.kind === 'scene';
  }

  isEditingPrefab(): boolean {
    return this._current.kind === 'prefab';
  }

  hasOpen(): boolean {
    return this._current.kind !== 'none';
  }

  /** 从 Bridge 心跳更新文档状态 */
  updateFromHeartbeat(hb: BridgeHeartbeat): void {
    const doc = hb.openDocument || hb.currentScene;
    if (!doc || !doc.kind) {
      if (!hb.hasOpenDocument && this._current.kind !== 'none') {
        this.close();
      }
      return;
    }

    const kind = doc.kind === 'prefab' ? 'prefab' : 'scene';
    const newState: DocumentStateInfo = {
      kind: kind as DocumentKind,
      dbUrl: (doc as Record<string,unknown>).dbUrl as string || null,
      path: (doc as Record<string,unknown>).path as string || null,
      assetUuid: (doc as Record<string,unknown>).assetUuid as string || null,
      rootUuid: (doc as Record<string, unknown>).rootNodeUuid as string || null,
      name: (doc as Record<string,unknown>).name as string || null,
    };

    if (!this._sameDoc(newState)) {
      this._pushHistory();
      this._current = newState;
    }
  }

  /** 是否匹配给定的目标 */
  matchesTarget(targetKind: string, targetPath?: string): boolean {
    if (this._current.kind !== targetKind) return false;
    if (targetPath && this._current.path && this._current.path !== targetPath) return false;
    return true;
  }

  getHistory(n: number = 20): DocumentStateInfo[] {
    return this._history.slice(-n);
  }

  // ----- private -----

  private _pushHistory(): void {
    if (this._current.kind !== 'none') {
      this._history.push({ ...this._current });
      if (this._history.length > BUFFER_EDIT_HISTORY) {
        this._history = this._history.slice(-BUFFER_EDIT_HISTORY);
      }
    }
  }

  private _sameDoc(other: DocumentStateInfo): boolean {
    return (
      this._current.kind === other.kind &&
      this._current.dbUrl === other.dbUrl &&
      this._current.assetUuid === other.assetUuid
    );
  }
}
