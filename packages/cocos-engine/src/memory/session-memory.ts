// ============================================================
// CommanderState — Commander 每轮调用的运行时状态
// 只存 Commander 翻译 DSL 真正需要的：tempId 映射 + 当前文档 + 轮次
// 其他（AssetCache、ScriptRegistry、execution log）是 Gateway 缓存，不在这里
// ============================================================

import { nowISO } from '../foundation/value-kit.js';

export interface DocumentInfo {
  kind: 'scene' | 'prefab' | 'none';
  path: string | null;
  rootUuid: string | null;
  name: string | null;
}

export class CommanderState {
  private _tempIdMap: Map<string, string> = new Map();
  private _pendingDelta: Set<string> = new Set();
  private _currentDocument: DocumentInfo = { kind: 'none', path: null, rootUuid: null, name: null };
  private _turn: number = 0;

  static create(): CommanderState {
    return new CommanderState();
  }

  // ===== tempId 映射（Commander 用 @R1 引用刚创建的节点） =====

  setTempIdMapping(tempId: string, realUuid: string): void {
    this._tempIdMap.set(tempId, realUuid);
    this._pendingDelta.add(tempId);
  }

  setTempIdMappings(map: Record<string, string>): void {
    for (const [k, v] of Object.entries(map)) {
      this._tempIdMap.set(k, v);
      this._pendingDelta.add(k);
    }
  }

  /** 本轮新增的 tempId 列表（仅 ID 名，不含 UUID），调用后清空 pending */
  flushDelta(): string[] {
    const ids = [...this._pendingDelta];
    this._pendingDelta.clear();
    return ids;
  }

  getRealUuid(tempId: string): string | null {
    return this._tempIdMap.get(tempId) || null;
  }

  /** 将文本中所有已知 tempId 替换为真实 UUID。按长度降序避免短名破坏长名 */
  resolveTempIds(text: string): string {
    let result = text;
    const sorted = [...this._tempIdMap].sort(([a], [b]) => b.length - a.length);
    for (const [tempId, uuid] of sorted) {
      const escaped = tempId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), uuid);
    }
    return result;
  }

  getTempIdMappings(): Record<string, string> {
    return Object.fromEntries(this._tempIdMap);
  }

  // ===== 当前文档 =====

  setCurrentDocument(doc: DocumentInfo): void {
    this._currentDocument = doc;
  }

  getCurrentDocument(): DocumentInfo {
    return this._currentDocument;
  }

  hasOpenDocument(): boolean {
    return this._currentDocument.kind !== 'none';
  }

  // ===== 轮次 =====

  nextTurn(): number {
    return ++this._turn;
  }

  getTurn(): number {
    return this._turn;
  }

  // ===== 重置 =====

  reset(): void {
    this._tempIdMap.clear();
    this._currentDocument = { kind: 'none', path: null, rootUuid: null, name: null };
    this._turn = 0;
  }
}

// ===== 向后兼容别名 =====
/** @deprecated 使用 CommanderState */
export const SessionMemory = CommanderState;
