/**
 * trigram-index.ts — 向后兼容 re-export
 *
 * ★ Trigram 纯函数已迁入 @comdr/core（零依赖共享）。
 *   此文件保留为 re-export，避免破坏现有 import 路径。
 *
 * @deprecated 新代码请直接 import from '@comdr/core'
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

export {
  textToVector,
  textsToVectors,
  cosineSimilarity,
  TrigramIndex,
  TRIGRAM_DEFAULT_DIMS,
} from '@comdr/core';
export type { IndexedDoc } from '@comdr/core';
