// ============================================================
// InternalAssetCatalog — Cocos 内置资产目录
// 数据来源：
//   1. Bridge 心跳 (editorCapabilities.internalAssets) — 运行时发现，最高优先级
//   2. 内置回退列表 (BUILTIN_INTERNAL_ASSETS)    — 离线/未运行兜底
//
// 引用格式：internal:<name> → 如 internal:default-sprite-frame
// 解析为 { __uuid__: "xxx", __expectedType__: "cc.SpriteFrame" }
// ============================================================

export interface InternalAssetEntry {
  uuid: string;
  type: string;       // cc.SpriteFrame | cc.Material | cc.Texture2D | ...
  name: string;       // display name (from .meta)
  subAsset?: string;  // @f9941 等子资产后缀
}

const INTERNAL_PREFIX = 'internal:';

/** 是否为 internal: 引用 */
export function isInternalRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(INTERNAL_PREFIX);
}

/** 从 internal:xxx 提取资产名 */
export function parseInternalRef(value: string): string | null {
  if (!isInternalRef(value)) return null;
  return value.slice(INTERNAL_PREFIX.length);
}

// ============================================================
// 内置回退列表 — Cocos 3.8.x 固定 UUID
// 从 engine/editor/assets/ 的 .meta 文件中提取
// 运行时 Bridge 心跳会覆盖此列表
// ============================================================

/** 这些 UUID 是 Cocos 编辑器的内置资源，跨项目恒定。
 *  来源：<Cocos安装目录>/resources/resources/3d/engine/editor/assets/
 *  每个 .meta 文件中的 uuid 字段。
 *
 *  注意：由于 uuid 依赖 Cocos 安装实例，此处提供默认空值作为回退。
 *  真正的 uuid 优先从 Bridge 心跳获取（_discoverInternalAssets）。
 *
 *  TODO(comdr): 若 Bridge 始终不可用（如 CI 环境），手动 fill 这些 uuid。
 */
const BUILTIN_INTERNAL_ASSETS: Record<string, Omit<InternalAssetEntry, 'name'>> = {
  'default-image':           { uuid: '', type: 'cc.ImageAsset' },
  'default-sprite-frame':    { uuid: '', type: 'cc.SpriteFrame' },
  'default-png':             { uuid: '', type: 'cc.ImageAsset' },
  'default-material':        { uuid: '', type: 'cc.Material' },
  'default-particle-mat':    { uuid: '', type: 'cc.Material' },
  'default-font':            { uuid: '', type: 'cc.TTFFont' },
  'default-trail-material':  { uuid: '', type: 'cc.Material' },
};

export class InternalAssetCatalog {
  private _assets: Map<string, InternalAssetEntry> = new Map();
  private _loaded: boolean = false;

  /** 从 Bridge 心跳加载（优先于内置回退） */
  loadFromBridge(bridgeAssets: Record<string, { uuid: string; type: string; name: string }> | undefined, _projectPath?: string): number {
    // 1. 始终先加载内置回退（保证所有 key 都有条目）
    let loaded = 0;
    for (const [key, entry] of Object.entries(BUILTIN_INTERNAL_ASSETS)) {
      this._assets.set(key, { ...entry, name: key });
      loaded++;
    }

    // 2. Bridge 数据覆盖（运行时发现，高优先级）
    if (bridgeAssets) {
      for (const [key, entry] of Object.entries(bridgeAssets)) {
        if (entry.uuid) {
          this._assets.set(key, {
            uuid: entry.uuid,
            type: entry.type || '',
            name: entry.name || key,
          });
        }
      }
    }

    this._loaded = true;
    return this._assets.size;
  }

  /** 获取资产条目 */
  get(name: string): InternalAssetEntry | null {
    return this._assets.get(name) || null;
  }

  /** 解析 internal:xxx 引用 → 完整条目 */
  resolve(ref: string): InternalAssetEntry | null {
    const name = parseInternalRef(ref);
    if (!name) return null;
    return this.get(name);
  }

  /** 解析为 Cocos 引用对象 { __uuid__: ..., __expectedType__: ... } */
  resolveToAssetRef(ref: string): Record<string, string> | null {
    const entry = this.resolve(ref);
    if (!entry || !entry.uuid) return null;
    const fullUuid = entry.subAsset ? `${entry.uuid}@${entry.subAsset}` : entry.uuid;
    return {
      __uuid__: fullUuid,
      __expectedType__: entry.type,
    };
  }

  get loaded(): boolean { return this._loaded; }
  get size(): number { return this._assets.size; }

  /** 列出所有已知 key（供 Commander 提示） */
  listKeys(): string[] {
    return [...this._assets.keys()];
  }
}
