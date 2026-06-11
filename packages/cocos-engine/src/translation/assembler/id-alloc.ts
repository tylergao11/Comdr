// ============================================================
// IdAlloc — 扁平化 ID 分配器（新模型版本）
// 纯函数风格，无类状态泄漏
// ============================================================

import { VALUE_TYPE_NAMES } from '../../model/cocos-world.js';
import { generateFileIdFallback } from '../../foundation/value-kit.js';
import { randomBytes } from 'crypto';

// ---- fileId 生成 ----

let _cryptoBytes: (() => string) | null = null;
function tryCryptoBytes(): string {
  if (_cryptoBytes === null) {
    try {
      if (typeof randomBytes === 'function') {
        _cryptoBytes = () => randomBytes(16).toString('base64').replace(/=+$/, '');
      } else {
        _cryptoBytes = generateFileIdFallback;
      }
    } catch {
      _cryptoBytes = generateFileIdFallback;
    }
  }
  return _cryptoBytes();
}

export function generateFileId(): string {
  return tryCryptoBytes();
}

// ---- ID 分配 ----

function isTypedObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.prototype.hasOwnProperty.call(v as Record<string, unknown>, '__type__');
}

export interface IdAllocResult {
  objects: Record<string, unknown>[];
  idMap: Map<Record<string, unknown>, number>;
  rootId: number | null;
}

/** 深度遍历对象树，为所有 __type__ 对象分配递增 ID（值类型除外） */
export function allocateIds(root: Record<string, unknown>): IdAllocResult {
  const objects: Record<string, unknown>[] = [];
  const idMap = new Map<Record<string, unknown>, number>();
  let nextId = 0;
  const visited = new Set<Record<string, unknown>>();

  const stack: Record<string, unknown>[] = [root];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (!obj || visited.has(obj)) continue;
    visited.add(obj);

    if (isTypedObject(obj)) {
      const typeName = obj.__type__ as string;
      if (!VALUE_TYPE_NAMES.has(typeName)) {
        obj.__id__ = nextId++;
        objects.push(obj);
        idMap.set(obj, nextId - 1);
      }
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !visited.has(v as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === 'object') {
              stack.push(item as Record<string, unknown>);
            }
          }
        } else {
          stack.push(v as Record<string, unknown>);
        }
      }
    }
  }

  const rootId = idMap.get(root) ?? null;
  return { objects, idMap, rootId };
}
