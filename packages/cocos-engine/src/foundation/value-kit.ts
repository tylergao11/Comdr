// ============================================================
// @comdr/core/foundation/value-kit
// 基础纯函数工具集 — 零依赖、零副作用
// ============================================================

import * as fs from 'fs';
import * as crypto from 'crypto';

// ----- JSON 工具 -----

/** 深拷贝 JSON 安全对象。优先使用 structuredClone（Node 17+），回退到 JSON 序列化 */
export function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value) as T;
  return JSON.parse(JSON.stringify(value));
}

/** 稳定哈希 (SHA-256 截断)，用于去重和缓存 key */
export function stableHash(input: string, length: number = 16): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

/** 读 UTF-8 JSON 文件，解析失败返回 null。调用方必须在 null 时做 fallback 处理。
 *  ENOENT（文件不存在）静默返回 null；其他错误写 stderr 后返回 null。 */
export function readJsonUtf8(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[comdr] readJsonUtf8 failed: ${filePath} — ${(e as Error).message}\n`);
    }
    return null;
  }
}

/** 原子写 JSON：先写 tmp，再 rename */
export function writeJsonAtomic(filePath: string, data: unknown, pretty?: boolean): void {
  const tmp = filePath + '.tmp.' + Date.now();
  const content = pretty
    ? JSON.stringify(data, null, 2) + '\n'
    : JSON.stringify(data) + '\n';
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // rename 跨设备可能失败，回退到直接写
    fs.writeFileSync(filePath, content, 'utf8');
    try { fs.rmSync(tmp, { force: true }); } catch (e) { process.stderr.write(`[comdr] tmp cleanup failed: ${tmp} — ${(e as Error).message}\n`); }
  }
}

// ----- 字符串工具 -----

/** 反斜杠统一为斜杠 */
export function normalizeSlash(s: string): string {
  return s.replace(/\\/g, '/');
}

/** 路径是否相等（忽略斜杠方向，忽略末尾斜杠） */
export function samePath(a: string, b: string): boolean {
  return normalizeSlash(a).replace(/\/$/, '') === normalizeSlash(b).replace(/\/$/, '');
}

/** 若输入非数组，包装为数组 */
export function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null) return [];
  return [String(v)];
}

/** 去重 + 排序 */
export function uniqueStrings(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

/** 安全的 ID 字符（取前 120 字符，仅保留字母数字和 . _ -） */
export function safeId(value: string): string {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.\-]/g, '_')
    .slice(0, 120);
}

// ----- Levenshtein 编辑距离（单行 DP + 长度预过滤）-----

/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 * 单行 DP — O(min(m,n)) 空间，O(m×n) 时间。
 * @param maxDist 超过此距离提前退出（用于模糊匹配阈值过滤）
 */
export function levenshtein(a: string, b: string, maxDist: number = Infinity): number {
  // 长度预过滤：差超过 maxDist 不可能匹配
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  // 确保 a 是较短的串（空间更省）
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const m = a.length;
  const n = b.length;

  // 单行 DP
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;

  for (let j = 1; j <= n; j++) {
    curr[0] = j;
    let rowMin = j;
    for (let i = 1; i <= m; i++) {
      curr[i] = a[i - 1] === b[j - 1]
        ? prev[i - 1]
        : 1 + Math.min(prev[i], curr[i - 1], prev[i - 1]);
      if (curr[i] < rowMin) rowMin = curr[i];
    }
    // 整行最小值已超阈值 → 提前退出
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }

  return prev[m];
}

// ----- 对象工具 -----

/** 从对象中挑选指定 key，跳过 null/undefined/空字符串 */
export function compactObject<T extends Record<string, unknown>>(
  value: T | null | undefined,
  keys: string[]
): Partial<T> | null {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const v = (value as Record<string, unknown> | null)?.[key];
    if (v === undefined || v === null || v === '') continue;
    output[key] = v;
  }
  return Object.keys(output).length > 0 ? (output as Partial<T>) : null;
}

/** 浅合并，b 覆盖 a */
export function mergeShallow<T extends Record<string, unknown>>(
  a: T,
  b: Partial<T>
): T {
  return { ...a, ...b };
}

// ----- 时间工具 -----

/** ISO 时间戳 */
export function nowISO(): string {
  return new Date().toISOString();
}

// ----- ID 生成 -----

/** UUID v4 生成器 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/** LCG 伪随机 UUID（crypto 不可用时的回退） */
export function generateFileIdFallback(): string {
  const hex = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  let seed = Date.now() % 2147483647;
  const rng = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed;
  };
  return hex.replace(/[xy]/g, (c) => {
    const r = (rng() % 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
