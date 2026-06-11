/**
 * retrieval.ts — BM25 全文检索
 *
 * ★ file_search 使用的 BM25 关键词检索引擎。
 *   episodic / world-model / tool_search 使用词级匹配。
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 分词（合并 episodic + tool-retriever 两套的最优策略）
// ============================================================================

/**
 * 统一分词——中文/英文/代码混合。
 *
 * 策略:
 *   1. 词级 token（空格/标点分割）—— 英文单词、路径段
 *   2. 字符 bigram —— 捕获子词模式 + CJK
 *   3. CJK 专用 bigram —— 中文无需空格分词
 *
 * 返回 token → 词频 的 Map。
 */
export function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lower = text.toLowerCase().trim();
  if (!lower) return counts;

  // 策略 1: 词级 token——按非字母数字非 CJK 字符分割
  // ★ 使用 Unicode property escape \p{sc=Han} 覆盖所有汉字（含 Extension B+），
  //   用 /u 标志保证 surrogate pair 正确匹配
  const words = lower.split(/[^a-zA-Z0-9\p{sc=Han}]+/u);
  for (const w of words) {
    if (w.length < 2) continue; // 跳过单字符（噪声大）
    if (/^[0-9]+$/.test(w) && w.length > 4) continue; // 跳过长数字串（UUID/hash 碎片——无检索价值）
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  // 策略 2: 字符 bigram（捕获子词模式 + CJK）
  for (let i = 0; i < lower.length - 1; i++) {
    const pair = lower.slice(i, i + 2);
    // 跳过纯空白
    if (/^\s+$/.test(pair)) continue;
    // 跳过纯标点（中英文标点）
    if (/^[，。！？、；：""''「」【】《》（）\s.,;:!?()\[\]{}"'`~/\\|@#$%^&*+=<>-]+$/.test(pair)) continue;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }

  return counts;
}

// ============================================================================
// §2 BM25 评分器
// ============================================================================

/**
 * BM25 评分器。
 *
 * BM25 相比 TF-IDF 的核心改进：
 *   - 词频饱和：tf / (tf + k1) 使高频词权重非线性增长
 *   - 文档长度归一化：长文档不会仅因为更长而获得更高分数
 *
 * 公式: score(q, d) = Σ IDF(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d|/avgdl))
 */
export class BM25Scorer {
  /** token → 出现在多少个文档中（用于 IDF） */
  private readonly docFreq = new Map<string, number>();
  /** 每个文档的 token 数 */
  private readonly docLengths: number[] = [];
  /** 文档总数 */
  private docCount = 0;
  /** k1 参数——词频饱和控制（默认 1.2） */
  private readonly k1: number;
  /** b 参数——文档长度归一化（默认 0.75） */
  private readonly b: number;

  constructor(k1: number = SYSTEM.BM25_K1, b: number = SYSTEM.BM25_B) {
    this.k1 = k1;
    this.b = b;
  }

  /**
   * 注册一个文档到索引。
   *
   * @param tokens  文档的分词结果（token → 词频）
   */
  addDocument(tokens: Map<string, number>): void {
    let docLen = 0;
    const seenTerms = new Set<string>();

    for (const [term, tf] of tokens) {
      docLen += tf;
      seenTerms.add(term);
    }

    // 更新文档频率（每个 term 在一个文档中只计一次）
    for (const term of seenTerms) {
      this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
    }

    this.docLengths.push(docLen);
    this.docCount++;
  }

  /**
   * 批量注册文档。
   */
  addDocuments(docs: Array<Map<string, number>>): void {
    for (const doc of docs) {
      this.addDocument(doc);
    }
  }

  /**
   * 计算查询与文档的 BM25 分数。
   *
   * @param queryTokens  查询的分词结果
   * @param docTokens    文档的分词结果
   * @returns BM25 分数（非归一化，仅用于排序）
   *
   * ★ 注意：docTokens 应为完整文档 token 而非 queryTokens 本身。
   *   若 docTokens 与 queryTokens 相同（文档本身也是查询），
   *   文档长度 docLen = queryTokens 总频 → 长度归一化因子偏小 → 分数失准。
   *   同步检索时（SQL 中 docTokens 可能丢失），调用方应对退化情况做检查。
   */
  score(queryTokens: Map<string, number>, docTokens: Map<string, number>): number {
    if (this.docCount === 0) return 0;

    const avgdl = this.avgDocLen;
    const docLen = [...docTokens.values()].reduce((s, v) => s + v, 0);

    let totalScore = 0;

    for (const [term, qtf] of queryTokens) {
      const dtf = docTokens.get(term);
      if (dtf === undefined || dtf === 0) continue;

      const idf = this.idf(term);
      // BM25 TF 饱和
      const numerator = dtf * (this.k1 + 1);
      const denominator = dtf + this.k1 * (1 - this.b + this.b * docLen / avgdl);
      totalScore += idf * qtf * (numerator / denominator);
    }

    return totalScore;
  }

  /**
   * 逆文档频率（BM25 标准公式）。
   *
   * IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
   */
  idf(term: string): number {
    const df = this.docFreq.get(term) ?? 0;
    return Math.log((this.docCount - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * 平均文档长度。
   */
  get avgDocLen(): number {
    if (this.docLengths.length === 0) return 1;
    const sum = this.docLengths.reduce((a, b) => a + b, 0);
    return sum / this.docLengths.length;
  }

  /**
   * 文档数量。
   */
  get documentCount(): number {
    return this.docCount;
  }

  /**
   * 清空索引。
   */
  clear(): void {
    this.docFreq.clear();
    this.docLengths.length = 0;
    this.docCount = 0;
  }
}

// ============================================================================
// §3 Contextual Prefix（Anthropic Contextual Retrieval 方案）
// ============================================================================

/**
 * Contextual Prefixer —— 给 chunk 加上下文描述前缀。
 *
 * 来源: Anthropic Contextual Retrieval (2024)
 * 核心思想: 在 embedding/tokenize 之前，给每个 chunk 加上描述其来源的上下文前缀。
 *          这样 TF-IDF/BM25 的词频就能直接落到正确的文档标识上。
 *          纯字符串操作，零额外成本。
 *
 * 例如:
 *   prefix("生命周期分为 onLoad、start、update...", {source: "cocos.md", heading: "Component"})
 *   → "[WorldModel: cocos.md § Component] 生命周期分为 onLoad、start、update..."
 */
export function contextualPrefix(
  text: string,
  context: { source: string; heading?: string },
): string {
  // ★ 转义 source/heading 中的 `[` `]`——否则破坏 `[label]` 格式
  const escSource = context.source.replace(/[\[\]]/g, '\\$&');
  const label = context.heading
    ? `${escSource} § ${context.heading.replace(/[\[\]]/g, '\\$&')}`
    : escSource;
  return `[${label}] ${text}`;
}

// ============================================================================
// §4 密集向量工具（episodic memory 用）
// ============================================================================

/**
 * FNV-1a 哈希 → 维度索引。
 *
 * 用于将 token 映射到固定维度向量（dense embedding）。
 * 保留此函数以支持 episodic memory 的 200 维 dense vector。
 */
export function hashToDim(token: string, dims: number): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % dims;
}

/**
 * 余弦相似度（假设向量均已 L2 归一化）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    // ★ 循环保证 0 <= i < a.length → a[i] 在 bounds 内
    dot += a[i]! * (b[i] ?? 0);
  }
  return dot;
}

/**
 * L2 归一化向量（原地修改）。
 */
export function l2Normalize(vec: number[]): void {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] = vec[i]! / norm;
    }
  }
}

// §5 已删除——SparseVector 工具随 BM25 退役。
// 密集向量 cosineSimilarity 保留（§4），用于 embedding 检索。
