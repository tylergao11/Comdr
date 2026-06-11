// ============================================================
// AssetCache — 持久化 path→UUID 缓存
// 存储位置: ~/.comdr/asset-cache.json
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { readJsonUtf8, writeJsonAtomic, normalizeSlash, nowISO } from '../foundation/value-kit.js';

export interface CacheEntry {
  uuid: string;
  updatedAt: string;
}

export interface AssetCacheData {
  schema: 'Comdr.asset-cache.v1';
  projectRoot: string;
  updatedAt: string;
  entries: Record<string, CacheEntry>;
}

const CACHE_SCHEMA = 'Comdr.asset-cache.v1';
const OLD_CACHE_SCHEMA = 'Cmdr.asset-cache.v1'; // 旧版本兼容
/** 缓存条目上限 — 超过此值按 LRU 淘汰最旧条目 */
const MAX_CACHE_ENTRIES = 10_000;

export class AssetCache {
  private _projectRoot: string;
  private _cachePath: string;
  private _entries: Map<string, CacheEntry> = new Map();
  private _dirty: boolean = false;
  private _autoFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(projectRoot: string, cachePath?: string) {
    this._projectRoot = normalizeSlash(projectRoot);
    this._cachePath = cachePath || path.join(
      process.env.HOME || process.env.USERPROFILE || '.',
      '.comdr',
      'asset-cache.json'
    );
  }

  // ----- 读取 -----

  load(): void {
    let data = readJsonUtf8(this._cachePath) as AssetCacheData | null;

    // 迁移：新路径无数据时尝试旧路径 (cmdr → comdr 重命名兼容)
    if (!data) {
      const oldPath = this._cachePath.replace(/[\\/]\.comdr[\\/]/, (sep) => `${sep === '/' ? '/' : '\\'}.cmdr${sep === '/' ? '/' : '\\'}`);
      if (oldPath !== this._cachePath) {
        const oldData = readJsonUtf8(oldPath) as AssetCacheData | null;
        if (oldData && ((oldData as unknown as Record<string,unknown>).schema === OLD_CACHE_SCHEMA || (oldData as unknown as Record<string,unknown>).schema === CACHE_SCHEMA)) {
          data = { ...oldData, schema: CACHE_SCHEMA };
          // 写入新位置
          const dir = path.dirname(this._cachePath);
          fs.mkdirSync(dir, { recursive: true });
          writeJsonAtomic(this._cachePath, data, true);
        }
      }
    }

    if (!data || ((data as unknown as Record<string,unknown>).schema !== CACHE_SCHEMA && (data as unknown as Record<string,unknown>).schema !== OLD_CACHE_SCHEMA)) return;

    // 仅加载同项目的数据
    if (normalizeSlash(data.projectRoot) !== this._projectRoot) return;

    this._entries.clear();
    for (const [k, v] of Object.entries(data.entries || {})) {
      this._entries.set(k, v);
    }
    this._dirty = false;
  }

  get(assetPath: string): string | null {
    const key = normalizeSlash(assetPath);
    return this._entries.get(key)?.uuid || null;
  }

  getBatch(paths: string[]): (string | null)[] {
    return paths.map((p) => this.get(p));
  }

  has(assetPath: string): boolean {
    return this._entries.has(normalizeSlash(assetPath));
  }

  allEntries(): Record<string, CacheEntry> {
    return Object.fromEntries(this._entries);
  }

  // ----- 写入 -----

  set(assetPath: string, uuid: string): void {
    const key = normalizeSlash(assetPath);
    // LRU 淘汰：超过上限时移除最旧的 N 条（按 updatedAt 排序）
    if (this._entries.size >= MAX_CACHE_ENTRIES && !this._entries.has(key)) {
      const sorted = [...this._entries.entries()]
        .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt));
      const evict = sorted.slice(0, Math.ceil(MAX_CACHE_ENTRIES * 0.1)); // 淘汰 10%
      for (const [k] of evict) this._entries.delete(k);
    }
    this._entries.set(key, { uuid, updatedAt: nowISO() });
    this._dirty = true;
  }

  setBatch(map: Record<string, string>): void {
    for (const [k, v] of Object.entries(map)) {
      this.set(k, v);
    }
  }

  invalidate(assetPath: string): void {
    this._entries.delete(normalizeSlash(assetPath));
    this._dirty = true;
  }

  invalidateAll(): void {
    this._entries.clear();
    this._dirty = true;
  }

  // ----- 持久化 -----

  get isDirty(): boolean {
    return this._dirty;
  }

  flush(): void {
    if (!this._dirty) return;
    const data: AssetCacheData = {
      schema: CACHE_SCHEMA,
      projectRoot: this._projectRoot,
      updatedAt: nowISO(),
      entries: Object.fromEntries(this._entries),
    };
    const dir = path.dirname(this._cachePath);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(this._cachePath, data, true);
    this._dirty = false;
  }

  /** 启用自动刷新（5 分钟间隔） */
  enableAutoFlush(intervalMs: number = 5 * 60 * 1000): void {
    if (this._autoFlushTimer) return;
    this._autoFlushTimer = setInterval(() => {
      if (this._dirty) this.flush();
    }, intervalMs);
    if (this._autoFlushTimer.unref) this._autoFlushTimer.unref();
  }

  /** 停用自动刷新定时器（不 flush） */
  disableAutoFlush(): void {
    if (this._autoFlushTimer) {
      clearInterval(this._autoFlushTimer);
      this._autoFlushTimer = null;
    }
  }

  /** 销毁定时器并刷新 */
  destroy(): void {
    if (this._autoFlushTimer) {
      clearInterval(this._autoFlushTimer);
      this._autoFlushTimer = null;
    }
    this.flush();
  }
}
