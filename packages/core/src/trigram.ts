/**
 * trigram.ts — 字符 Trigram 向量索引
 *
 * ★ 零模型、零正则、零外部依赖。
 *   字符 trigram 对所有语言通用——中文、英文、代码均不需分词器。
 *
 * 原理:
 *   "登录" → 2-gram: [登, 录, 登录]  (单字符 + bigram + trigram)
 *   "login" → [l, o, g, i, n, lo, og, gi, in, log, ogi, gin]
 *   每个 trigram FNV-1a 哈希 → 256 维向量索引 → TF 加权 → L2 归一化
 *
 * 对比:
 *   BM25:      词袋，依赖 regex tokenizer，跨语言弱
 *   Trigram:    字符 n-gram，无需分词，语言无关
 *   + 查询扩展: flash LLM "登录"→"login auth"， trigram 匹配英文代码
 *
 * @agent Agent 1 — 此文件由 Agent 1 维护，是 trigram 算法的唯一真理源
 */

// ============================================================================
// §1 向量化
// ============================================================================

/** 默认 embedding 维度 */
export const TRIGRAM_DEFAULT_DIMS = 256;

/**
 * 文本 → trigram 加权向量（L2 归一化）。
 *
 * 策略:
 *   1. 单字符（uni-gram）—— 捕获 CJK 单字
 *   2. 字符 bigram —— 捕获词级模式
 *   3. 字符 trigram —— 捕获子词模式
 *
 * @param text  任意语言文本
 * @param dims  向量维度（默认 256）
 * @returns     L2 归一化的 Float32Array
 */
export function textToVector(text: string, dims: number = TRIGRAM_DEFAULT_DIMS): Float32Array {
  const vec = new Float32Array(dims);
  const lower = text.toLowerCase();
  if (!lower) return vec;

  const tf = new Map<string, number>();
  const add = (s: string) => tf.set(s, (tf.get(s) ?? 0) + 1);

  // 单字符
  for (const ch of lower) {
    if (ch !== ' ') add(ch);
  }
  // bigram
  for (let i = 0; i < lower.length - 1; i++) {
    add(lower.slice(i, i + 2));
  }
  // trigram
  for (let i = 0; i < lower.length - 2; i++) {
    add(lower.slice(i, i + 3));
  }

  // FNV-1a 哈希 → 维度索引 + TF 加权
  for (const [gram, freq] of tf) {
    let hash = 2166136261;
    for (let i = 0; i < gram.length; i++) {
      hash ^= gram.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = (hash >>> 0) % dims;
    vec[idx] = vec[idx]! + freq;
  }

  // L2 归一化
  l2Normalize(vec);
  return vec;
}

/**
 * 批量向量化。
 */
export function textsToVectors(texts: string[], dims?: number): Float32Array[] {
  return texts.map((t) => textToVector(t, dims));
}

// ============================================================================
// §2 相似度
// ============================================================================

/**
 * 余弦相似度（假设向量均已 L2 归一化 → dot product = cosine）。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

// ============================================================================
// §3 TrigramIndex —— 多文档索引 + 检索
// ============================================================================

export interface IndexedDoc {
  id: string;
  vector: Float32Array;
  /** 可选——检索时随结果返回的附加数据 */
  data?: unknown;
}

export class TrigramIndex {
  private docs: IndexedDoc[] = [];
  private readonly dims: number;

  constructor(dims: number = TRIGRAM_DEFAULT_DIMS) {
    this.dims = dims;
  }

  /** 添加文档 */
  add(id: string, text: string, data?: unknown): void {
    this.docs.push({
      id,
      vector: textToVector(text, this.dims),
      data,
    });
  }

  /** 批量添加 */
  addBatch(items: Array<{ id: string; text: string; data?: unknown }>): void {
    for (const item of items) {
      this.add(item.id, item.text, item.data);
    }
  }

  /** 删除文档 */
  remove(id: string): void {
    this.docs = this.docs.filter((d) => d.id !== id);
  }

  /** 清空 */
  clear(): void {
    this.docs = [];
  }

  /**
   * 检索——trigram 向量余弦相似度排序。
   *
   * @param query     查询文本
   * @param topK      返回 top-K
   * @param minScore  最低分数阈值（默认 0，返回所有）
   */
  search(query: string, topK: number = 5, minScore: number = 0): IndexedDoc[] {
    if (this.docs.length === 0) return [];

    const queryVec = textToVector(query, this.dims);

    const scored = this.docs
      .map((doc) => ({ doc, score: cosineSimilarity(queryVec, doc.vector) }))
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map((s) => s.doc);
  }

  /** 文档数量 */
  get size(): number {
    return this.docs.length;
  }
}

// ============================================================================
// §4 工具函数
// ============================================================================

function l2Normalize(vec: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i]! * vec[i]!;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = vec[i]! / norm;
    }
  }
}
