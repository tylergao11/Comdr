// ============================================================
// AssetResolver — 自动将资产路径解析为 UUID
// 当 set-prop/compile 的值看起来像文件路径，且目标属性
// 是 asset 引用类型时，自动 probe 解析路径 → UUID
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { ComponentCatalog } from '../model/component-catalog.js';
import { guessAssetType } from '../model/cocos-world.js';
import { ToolCenter } from '../tool-center/tool-center.js';
import { AssetCache } from '../memory/asset-cache.js';

// ===== 子资产映射 =====

/** property → 期望的 subMetas importer（用于从 .meta 中定位正确的子资产 UUID） */
const PROPERTY_IMPORTER_MAP: Record<string, string> = {
  spriteFrame: 'sprite-frame',
  _spriteFrame: 'sprite-frame',
  normalSprite: 'sprite-frame',
  pressedSprite: 'sprite-frame',
  hoverSprite: 'sprite-frame',
  disabledSprite: 'sprite-frame',
  spriteAtlas: 'sprite-atlas',
  _spriteAtlas: 'sprite-atlas',
  _atlas: 'sprite-atlas',
};

/** subMetas importer → __expectedType__ */
const IMPORTER_EXPECTED_TYPE: Record<string, string> = {
  'sprite-frame': 'cc.SpriteFrame',
  'texture': 'cc.Texture2D',
  'image': 'cc.ImageAsset',
  'sprite-atlas': 'cc.SpriteAtlas',
};

/**
 * 读 .meta 的 subMetas，找与 property 匹配的子资产 UUID。
 * @returns { uuid, expectedType } 或 null（无需子资产解析）
 */
function resolveSubAssetFromMeta(
  mainUuid: string,
  projectPath: string,
  originalAssetPath: string,
  propertyName: string,
): { uuid: string; expectedType?: string } | null {
  if (!mainUuid || mainUuid.includes('@')) return null; // 已是子资产 UUID

  try {
    // 从 originalAssetPath 推导 .meta 路径
    const cleanPath = originalAssetPath.replace(/^db:\/\/assets\//, '').replace(/^assets\//, '');
    const metaPath = path.join(projectPath, 'assets', cleanPath + '.meta');
    if (!fs.existsSync(metaPath)) return null;

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const subMetas = meta.subMetas as Record<string, { importer?: string; uuid?: string; name?: string }> | undefined;
    if (!subMetas || Object.keys(subMetas).length === 0) return null;

    // 1. 精确匹配：property → importer 映射
    const targetImporter = PROPERTY_IMPORTER_MAP[propertyName];
    if (targetImporter) {
      for (const [id, entry] of Object.entries(subMetas)) {
        if (entry.importer === targetImporter && entry.uuid) {
          return {
            uuid: entry.uuid,
            expectedType: IMPORTER_EXPECTED_TYPE[targetImporter],
          };
        }
      }
    }

    // 2. 回退：property name 匹配 subMeta.name（去掉 _ 前缀）
    const cleanProp = propertyName.replace(/^_/, '');
    for (const [id, entry] of Object.entries(subMetas)) {
      if (entry.name === cleanProp && entry.uuid) {
        return {
          uuid: entry.uuid,
          expectedType: entry.importer ? IMPORTER_EXPECTED_TYPE[entry.importer] : undefined,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** 判断字符串是否看起来像资产路径（非 UUID） */
export function looksLikeAssetPath(value: string): boolean {
  if (!value || value.length < 5) return false;
  // UUID 格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(value)) return false;
  // 资产路径特征
  if (value.startsWith('assets/') || value.startsWith('db://assets/')) return true;
  // 资源文件扩展名（图片、音频、字体等）
  if (/\.(png|jpe?g|gif|webp|svg|bmp|tga|psd|ttf|otf|mp3|wav|ogg|aac|json|plist|atlas|prefab|scene|anim|fbx|gltf|glb|mesh|mat|mtl|astc|pkm|pvr|dds|bin|bytes|csv|txt)(\.[a-z0-9]+)?$/i.test(value)) return true;
  return false;
}

/** 判断属性是否需要资产引用（组件 schema 查询） */
export function isAssetProperty(componentType: string, propertyName: string, catalog?: ComponentCatalog | null): boolean {
  if (!catalog) return false;
  const entry = catalog.get(componentType);
  if (!entry) return false;
  const field = entry.schema.find((f) => f.name === propertyName || f.name === `_${propertyName}`);
  return field?.type === 'asset';
}

/** 单次资产路径解析：路径 → UUID（优先从缓存读，miss 则 probe Bridge 并回写缓存）
 *  自动尝试补全 assets/ 前缀（Commander 可能给出 package/xxx.png 而非 assets/package/xxx.png） */
export async function resolveAssetPath(
  value: string,
  toolCenter: ToolCenter,
  signal?: AbortSignal,
  cache?: AssetCache | null,
): Promise<string | null> {
  // 尝试的路径顺序：原路径 → assets/ → db://assets/
  const candidates = [value];
  if (!value.startsWith('db://') && !value.startsWith('/')) {
    if (!value.startsWith('assets/')) candidates.push('assets/' + value);
    candidates.push('db://assets/' + value.replace(/^assets\//, ''));
  }

  for (const p of candidates) {
    if (cache) { const c = cache.get(p); if (c) return c; }
    try {
      const result = await toolCenter.submit({type:'probe',payload:{probeType:'asset',path:p}},signal);
      if (result.ok && result.data) {
        const data = result.data as Record<string,unknown>;
        const uuid = (typeof data.uuid === 'string' && data.uuid)
          || (data.data && typeof data.data === 'object' && typeof (data.data as Record<string,unknown>).uuid === 'string'
            ? (data.data as Record<string,unknown>).uuid as string : null);
        if (uuid) { if (cache) cache.set(p, uuid); return uuid; }
      }
    } catch (e) {
      process.stderr.write(`[comdr] asset resolve failed for ${p}: ${(e as Error).message}\n`);
    }
  }
  return null;
}

/** 解析组件属性值中的资产路径 → UUID（含子资产 @ 后缀） */
export async function resolveAssetValue(
  componentType: string,
  property: string,
  value: unknown,
  toolCenter: ToolCenter,
  signal?: AbortSignal,
  cache?: AssetCache | null,
  projectPath?: string,
  catalog?: ComponentCatalog | null,
): Promise<{ resolved: unknown; resolvedPath?: string; expectedType?: string }> {
  if (typeof value !== 'string') return { resolved: value };
  if (!looksLikeAssetPath(value)) return { resolved: value };
  if (!isAssetProperty(componentType, property, catalog)) return { resolved: value };

  const mainUuid = await resolveAssetPath(value, toolCenter, signal, cache);
  if (!mainUuid) {
    // 检查 Bridge 是否返回了模糊匹配候选列表
    let candidates: string[] = [];
    try {
      const result = await toolCenter.submit({type:'probe',payload:{probeType:'asset',path:value}},signal);
      if (result.ok && result.data) {
        const data = result.data as Record<string,unknown>;
        const fuzzyList = data.candidates as Array<{path:string; uuid:string}> | undefined;
        if (fuzzyList && fuzzyList.length > 0) {
          candidates = fuzzyList.map((c) => c.path);
        }
      }
    } catch { /* best-effort */ }
    if (candidates.length > 0) {
      throw new Error(`Asset "${value}" not found. Did you mean one of:\n  ${candidates.join('\n  ')}`);
    }
    throw new Error(`Asset not found: "${value}". Did you truncate the path? Use the full relative path from probe result (e.g. model/helloWorld/sky.png), not just the filename.`);
  }

  // 子资产解析：读取 .meta → subMetas → 匹配 @f9941 等后缀
  if (projectPath) {
    const sub = resolveSubAssetFromMeta(mainUuid, projectPath, value, property);
    if (sub) {
      // 包装为 Cocos 资产引用格式 { __uuid__: ..., __expectedType__: ... }
      return {
        resolved: sub.expectedType
          ? { __uuid__: sub.uuid, __expectedType__: sub.expectedType }
          : { __uuid__: sub.uuid },
        resolvedPath: value,
        expectedType: sub.expectedType,
      };
    }
  }

  // 包装为 Cocos 资产引用格式 { __uuid__: ... }
  const expectedType = guessAssetType(property);
  const wrapped = expectedType
    ? { __uuid__: mainUuid, __expectedType__: expectedType }
    : { __uuid__: mainUuid };
  return { resolved: wrapped, resolvedPath: value, expectedType };
}
// guessExpectedType 由 cocos-world.ts 的 guessAssetType 提供（单一真实源）

/** 批量解析：遍历 props，自动解析 asset 类型的值 */
export async function resolveAssetValues(
  componentType: string,
  props: Record<string, unknown>,
  toolCenter: ToolCenter,
  signal?: AbortSignal,
  cache?: AssetCache | null,
  projectPath?: string,
  catalog?: ComponentCatalog | null,
): Promise<{ props: Record<string, unknown>; resolved: Array<{ property: string; path: string; uuid: string }> }> {
  const resolved: Array<{ property: string; path: string; uuid: string }> = [];
  const newProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    const result = await resolveAssetValue(componentType, key, value, toolCenter, signal, cache, projectPath, catalog);
    newProps[key] = result.resolved;
    if (result.resolvedPath && typeof result.resolvedPath === 'string') {
      const uuid = typeof result.resolved === 'object' && result.resolved !== null
        ? (result.resolved as Record<string, unknown>).__uuid__ as string
        : typeof result.resolved === 'string' ? result.resolved : '';
      if (uuid) resolved.push({ property: key, path: result.resolvedPath, uuid });
    }
  }

  return { props: newProps, resolved };
}
