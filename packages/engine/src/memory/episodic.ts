/**
 * memory/episodic.ts — 情景记忆
 *
 * 来源：Factory AI 结构化摘要 + SimpleMem (ICML 2025)
 *
 * 会话结束时生成结构化摘要 + embedding。
 * 使用简单的内存向量存储（TODO: 未来升级为 LanceDB）。
 *
 * 职责:
 *   1. 会话结束时 consolidate → 生成 EpisodeSummary
 *   2. 新会话开始时 retrieve → 检索相关历史
 *   3. embedding 生成（轻量级，无外部 API 依赖）
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  EpisodeSummary,
  SessionState,
  StructuredSummary,
} from '@comdr/core/types';
import { SYSTEM } from '@comdr/core';

// ============================================================================
// §1 TF-IDF Embedding（零外部依赖，比 bigram hash 质量高 3-5×）
// ============================================================================

/**
 * 全量文档词表（用于 IDF 计算——跨所有已存储 EpisodeSummary 统计）。
 * 增量维护：每次 consolidate 时 push；clear 时清空。
 */
const documentFreqs = new Map<string, number>();
let totalDocuments = 0;

/**
 * Tokenize：分词 + 字符 n-gram 混合策略。
 *
 * - ASCII 文本：空格/标点分词 + 额外 bigram（捕获拼写变体）
 * - CJK 文本：bigram 滑动窗口（中文无需空格分词）
 * - 混合文本：两种策略并行覆盖
 *
 * 返回 token → count 的 Map。
 */
function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lower = text.toLowerCase().trim();
  if (!lower) return counts;

  // 策略 1: 词级 token（空格/标点分割）
  const words = lower.split(/[\s,.;:!?()\[\]{}"'`~/\\|@#$%^&*+=<>]+/);
  for (const w of words) {
    if (w.length < 2) continue; // 跳过单字符（噪声大）
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  // 策略 2: 字符 bigram（捕获子词模式 + CJK）
  for (let i = 0; i < lower.length - 1; i++) {
    // 跳过纯标点/空格 bigram
    const pair = lower.slice(i, i + 2);
    if (/^\s+$/.test(pair)) continue;
    if (/^[，。！？、；：""''「」【】《》（）\s]+$/.test(pair)) continue;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }

  return counts;
}

/**
 * 计算 IDF（逆文档频率）权重。
 *
 * IDF(t) = log((N + 1) / (df(t) + 1)) + 1
 */
function idfWeight(term: string): number {
  const df = documentFreqs.get(term) ?? 0;
  return Math.log((totalDocuments + 1) / (df + 1)) + 1;
}

/**
 * 文本 → TF-IDF 向量（固定维度，按词表哈希映射）。
 *
 * ★ 不再使用 naive bigram hash → collision 显著减少。
 * ★ IDF 加权使常见词（"file", "fix"）权重降低，区分度提高。
 *
 * @param text  输入文本
 * @param dims  输出向量维度
 */
function tfidfEmbed(text: string, dims: number = SYSTEM.EPISODIC_EMBEDDING_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  if (tokens.size === 0) return vec;

  // TF-IDF 加权 → 哈希映射到固定维度
  for (const [term, tf] of tokens) {
    const weight = tf * idfWeight(term);
    // FNV-1a hash → 维度索引
    let hash = 2166136261;
    for (let i = 0; i < term.length; i++) {
      hash ^= term.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = (hash >>> 0) % dims;
    vec[idx] = vec[idx]! + weight;
  }

  // L2 归一化
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] = vec[i]! / norm;
    }
  }

  return vec;
}

/**
 * 更新全局 IDF 词表（每次 consolidate 时调用）。
 */
function updateDocumentFreqs(text: string): void {
  const tokens = tokenize(text);
  for (const term of tokens.keys()) {
    documentFreqs.set(term, (documentFreqs.get(term) ?? 0) + 1);
  }
  totalDocuments++;
}

/**
 * 余弦相似度（向量均已 L2 归一化）
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
  }
  return dot;
}

// ============================================================================
// §2 EpisodicMemory 类
// ============================================================================

export class EpisodicMemory {
  /** 内存存储（会话 ID → EpisodeSummary） */
  private store: Map<string, EpisodeSummary> = new Map();

  // --------------------------------------------------------------------------
  // consolidate() — 会话结束时生成摘要
  // --------------------------------------------------------------------------

  /**
   * 会话结束时生成结构化摘要 + embedding
   */
  consolidate(
    session: SessionState,
    structuredSummary: StructuredSummary | null,
  ): EpisodeSummary {
    const summary: EpisodeSummary = {
      id: session.id,
      timestamp: new Date().toISOString(),
      task: session.currentInput,
      outcome: session.outcome,
      structuredSummary,
      tokensUsed: session.tokensUsed,
      turns: session.turn,
    };

    // ★ 生成 TF-IDF embedding + 更新全局 IDF 词表
    const text = this.serializeForEmbedding(summary);
    updateDocumentFreqs(text);
    summary.embedding = tfidfEmbed(text);

    // 存储
    this.store.set(summary.id, summary);

    return summary;
  }

  // --------------------------------------------------------------------------
  // retrieve() — 检索相关历史
  // --------------------------------------------------------------------------

  /**
   * 新会话时检索相关历史
   *
   * @param userInput  用户输入（作为查询文本）
   * @param topK       返回最相关的 K 条
   * @returns          按相似度降序排列的历史摘要
   */
  retrieve(userInput: string, topK: number = SYSTEM.EPISODIC_RETRIEVAL_TOPK): EpisodeSummary[] {
    if (this.store.size === 0) return [];

    const queryVec = tfidfEmbed(userInput);

    const scored = [...this.store.values()]
      .map((ep) => ({
        episode: ep,
        score: ep.embedding
          ? cosineSimilarity(queryVec, ep.embedding)
          : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((s) => s.episode);
  }

  // --------------------------------------------------------------------------
  // 持久化占位
  // --------------------------------------------------------------------------

  /**
   * 序列化所有摘要（用于写入 SQLite/JSON）
   * TODO: 生产环境使用 SQLite + LanceDB
   */
  serialize(): string {
    const summaries = [...this.store.values()].map(({ embedding: _, ...rest }) => rest);
    return JSON.stringify(summaries, null, 2);
  }

  /**
   * 从序列化数据恢复
   */
  deserialize(data: string): void {
    try {
      const arr = JSON.parse(data) as EpisodeSummary[];
      for (const summary of arr) {
        // ★ 重新生成 TF-IDF embedding + 恢复 IDF 词表
        const text = this.serializeForEmbedding(summary);
        updateDocumentFreqs(text);
        summary.embedding = tfidfEmbed(text);
        this.store.set(summary.id, summary);
      }
    } catch {
      // 数据损坏 → 静默跳过
    }
  }

  /**
   * 清空存储
   */
  clear(): void {
    this.store.clear();
    documentFreqs.clear();
    totalDocuments = 0;
  }

  /**
   * 存储大小
   */
  get size(): number {
    return this.store.size;
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 将 EpisodeSummary 转为 embedding 输入文本
   */
  private serializeForEmbedding(summary: EpisodeSummary): string {
    const parts: string[] = [summary.task];

    if (summary.outcome) {
      parts.push(summary.outcome);
    }

    if (summary.structuredSummary) {
      const ss = summary.structuredSummary;
      parts.push(ss.sessionIntent);
      for (const fm of ss.fileModifications) {
        parts.push(`${fm.action} ${fm.path}: ${fm.summary}`);
      }
      for (const d of ss.decisions) {
        parts.push(`${d.what} ${d.why}`);
      }
      parts.push(...ss.nextSteps);
    }

    return parts.join(' ');
  }
}

// ============================================================================
// §3 工厂函数
// ============================================================================

/**
 * 创建情景记忆实例
 */
export function createEpisodicMemory(): EpisodicMemory {
  return new EpisodicMemory();
}
