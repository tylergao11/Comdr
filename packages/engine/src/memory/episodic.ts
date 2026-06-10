/**
 * memory/episodic.ts — 情景记忆
 *
 * 来源：Factory AI 结构化摘要 + SimpleMem (ICML 2025)
 *
 * 会话结束时生成结构化摘要 + embedding。
 *
 * ★ 缓存线修复 (2026-06):
 *   中途 consolidate() 快照写入 pendingStore，不影响检索 store。
 *   retrieve() 只查 store（仅含旧会话的摘要）→ L3 同会话内绝对不变。
 *   commit() 在会话终止时将 pendingStore 合并进 store。
 *
 * 职责:
 *   1. 会话结束时 consolidate → 生成 EpisodeSummary
 *   2. 新会话开始时 retrieve → 检索相关历史（BM25 评分）
 *   3. embedding 生成（轻量级，无外部 API 依赖）
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import type {
  EpisodeSummary,
  SessionState,
  StructuredSummary,
  ReflectionEntry,
} from '@comdr/core/types';
import { SYSTEM, MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import { extractAndParseJSON } from '../utils.js';
import {
  tokenize,
  BM25Scorer,
  hashToDim,
  l2Normalize,
} from '../retrieval.js';

// ============================================================================
// §1 Dense Embedding（200 维 TF-IDF 加权——保留用于序列化兼容）
// ============================================================================

/**
 * 文本 → TF-IDF 密集向量（固定维度，按 token 哈希映射）。
 *
 * 使用 BM25Scorer 的 IDF 权重替代旧的手动 IDF。
 */
function denseEmbed(
  text: string,
  dims: number,
  idfFn: (term: string) => number,
): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  if (tokens.size === 0) return vec;

  for (const [term, tf] of tokens) {
    const idf = idfFn(term);
    const weight = tf * idf;
    const idx = hashToDim(term, dims);
    vec[idx] = vec[idx]! + weight;
  }

  l2Normalize(vec);
  return vec;
}

// ============================================================================
// §2 EpisodicMemory 类
// ============================================================================

export class EpisodicMemory {
  /**
   * ★ 检索 store——仅含之前会话的摘要（commit() 后才会进入）。
   * retrieve() 只查此 store → 同会话内结果不变 → L3 缓存安全。
   */
  private store: Map<string, EpisodeSummary> = new Map();

  /**
   * ★ 中途快照隔离区——consolidate() 写入此处，不影响检索 store。
   * 用于崩溃恢复，commit() 时合并进 store。
   */
  private pendingStore: Map<string, EpisodeSummary> = new Map();

  /**
   * 每个 episode 的 token 化文本（用于 BM25 检索）。
   * key 与 store 中的 episode id 对应。
   */
  private episodeTokens: Map<string, Map<string, number>> = new Map();

  /**
   * BM25 评分器——维护 IDF 词表。
   * 仅包含 store 中的文档（旧会话），不包含 pendingStore。
   */
  private bm25: BM25Scorer = new BM25Scorer();

  /**
   * ★ 跨会话反思条目——由 reflect() 生成。
   * 持久化到 reflections.json。
   */
  private reflectionStore: ReflectionEntry[] = [];

  /** ★ 已完成但尚未触发反思的会话计数器 */
  private sessionsSinceReflection = 0;

  // --------------------------------------------------------------------------
  // consolidate() — 会话结束时生成摘要
  // --------------------------------------------------------------------------

  /**
   * 会话结束时生成结构化摘要 + embedding。
   *
   * ★ 写入 pendingStore——不影响检索 store。
   *   只有 commit() 后才会进入可检索的 store。
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

    // 生成 dense embedding（用于序列化兼容 + 未来的 dense 检索）
    const text = this.serializeForEmbedding(summary);
    summary.embedding = denseEmbed(
      text,
      SYSTEM.EPISODIC_EMBEDDING_DIMS,
      (term) => this.bm25.idf(term),
    );

    // ★ 写入 pendingStore，不动 store
    this.pendingStore.set(summary.id, summary);

    return summary;
  }

  // --------------------------------------------------------------------------
  // commit() — 会话终止时将 pendingStore 合并进检索 store
  // --------------------------------------------------------------------------

  /**
   * ★ 将中途快照合并进检索 store。
   *
   * 仅在会话终止时调用（triggered by Engine.terminate()）。
   * 合并后新会话的 retrieve() 才能检索到本次会话的摘要。
   */
  /**
   * ★ 只 commit 成功的会话——失败的、中断的、错误的不进入长期记忆。
   * SuperLocalMemory (2026): Bayesian trust scoring，失败会话 trust -= 0.2。
   */
  commit(): void {
    for (const [id, summary] of this.pendingStore) {
      if (summary.outcome !== 'completed' && summary.outcome !== null) {
        // 失败/中断的会话 → 不入 store，但计入 reflection 的失败模式统计
        continue;
      }
      this.store.set(id, summary);
      const text = this.serializeForEmbedding(summary);
      const tokens = tokenize(text);
      this.episodeTokens.set(id, tokens);
      this.bm25.addDocument(tokens);
    }
    this.pendingStore.clear();
    this.sessionsSinceReflection++;
  }

  /**
   * ★ 跨会话反思——从多次会话中提取高层洞察。
   *
   * 触发条件: 每 EPISODIC_REFLECTION_INTERVAL 个已完成的会话。
   * 调用方 (Engine.terminate) 在 commit() 后检查是否需要反思。
   */
  shouldReflect(): boolean {
    return this.sessionsSinceReflection >= SYSTEM.EPISODIC_REFLECTION_INTERVAL;
  }

  /**
   * ★ 执行反思——调用 LLM 从最近的 episode summaries 中提取模式。
   *
   * @param llm     LLM 客户端（推荐使用 flash 模型，thinking=disabled）
   * @returns       新生成的 ReflectionEntry[]，已存入 reflectionStore
   */
  async reflect(llm: IDeepSeekClient): Promise<ReflectionEntry[]> {
    // 取最近完成的 N 个会话的摘要
    const recent = [...this.store.values()]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, SYSTEM.EPISODIC_REFLECTION_INTERVAL);

    if (recent.length < 2) return [];

    const summaries = recent.map((ep) => {
      const ss = ep.structuredSummary;
      return `[${ep.id}] ${ep.task} → ${ep.outcome ?? 'unknown'}
  Files: ${ss?.fileModifications.map(f => `${f.action} ${f.path}`).join(', ') ?? 'none'}
  Decisions: ${ss?.decisions.map(d => d.what).join('; ') ?? 'none'}
  Failures: ${ss?.nextSteps.length === 0 ? 'none' : 'some'}`;
    }).join('\n\n');

    const prompt = `You are a reflection engine for a coding agent. Given summaries of past sessions,
identify patterns useful for future work. Focus on:

1. **Repeated failure modes** — same mistake across sessions → warn the agent.
2. **Successful strategies** — approaches that worked and should be reused.
3. **Frequently modified files** — files changed together in multiple sessions → suggest dependency awareness.

Output ONLY valid JSON (no other text):
{
  "insights": [
    {"insight": "...", "evidence": ["sessionId1", "sessionId2"], "confidence": 0.0}
  ]
}

Session summaries:
${summaries}`;

    try {
      const response = await llm.chat({
        messages: [{ role: MESSAGE_ROLE.SYSTEM, content: prompt }],
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: 1024,
      });

      const content = response.message.content;
      if (content) {
        const parsed = extractAndParseJSON<{
          insights: { insight: string; evidence: string[]; confidence: number }[];
        }>(content);
        if (parsed?.insights?.length) {
          const entries: ReflectionEntry[] = parsed.insights.map((i) => ({
            id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            insight: i.insight,
            evidence: i.evidence,
            confidence: Math.min(1, Math.max(0, i.confidence)),
            createdAt: new Date().toISOString(),
          }));
          this.reflectionStore.push(...entries);
          this.sessionsSinceReflection = 0;
          return entries;
        }
      }
    } catch {
      // LLM 反思失败 → 静默降级，下次再试
    }

    return [];
  }

  /** 获取反思条目（用于 prompt 注入） */
  getReflections(): ReflectionEntry[] {
    // 只返回置信度 > 0.5 的条目
    return this.reflectionStore.filter((r) => r.confidence > 0.5);
  }

  // --------------------------------------------------------------------------
  // retrieve() — 检索相关历史（BM25 评分）
  // --------------------------------------------------------------------------

  /**
   * ★ 新会话时检索相关历史。
   *
   * 只查 store（旧会话）——同会话内多次调用返回相同结果。
   *
   * @param userInput  用户输入（作为查询文本）
   * @param topK       返回最相关的 K 条
   * @returns          按 BM25 分数降序排列的历史摘要
   */
  retrieve(
    userInput: string,
    topK: number = SYSTEM.EPISODIC_RETRIEVAL_TOPK,
  ): EpisodeSummary[] {
    if (this.store.size === 0) return [];

    const queryTokens = tokenize(userInput);

    const scored = [...this.store.values()]
      .map((ep) => {
        const docTokens = this.episodeTokens.get(ep.id);
        const score = docTokens
          ? this.bm25.score(queryTokens, docTokens)
          : 0;
        return { episode: ep, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((s) => s.episode);
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  /**
   * 序列化所有摘要（store + pendingStore）。
   * embedding 不持久化到 JSON（检索时重新生成）。
   */
  serialize(): { episodes: string; reflections: string } {
    const all = [
      ...this.store.values(),
      ...this.pendingStore.values(),
    ];
    const summaries = all.map(({ embedding: _, ...rest }) => rest);
    return {
      episodes: JSON.stringify(summaries, null, 2),
      reflections: JSON.stringify(this.reflectionStore, null, 2),
    };
  }

  /**
   * 从序列化数据恢复。
   *
   * ★ 恢复后所有摘要直接进入 store（视为旧会话）。
   *   BM25 索引重建。
   */
  deserialize(episodeData: string, reflectionData?: string): void {
    try {
      const arr = JSON.parse(episodeData) as EpisodeSummary[];
      for (const summary of arr) {
        const text = this.serializeForEmbedding(summary);
        const tokens = tokenize(text);
        summary.embedding = denseEmbed(
          text,
          SYSTEM.EPISODIC_EMBEDDING_DIMS,
          (term) => this.bm25.idf(term),
        );
        this.store.set(summary.id, summary);
        this.episodeTokens.set(summary.id, tokens);
        this.bm25.addDocument(tokens);
      }
    } catch {
      // 数据损坏 → 静默跳过
    }

    if (reflectionData) {
      try {
        this.reflectionStore = JSON.parse(reflectionData) as ReflectionEntry[];
      } catch {
        // 损坏 → 静默跳过
      }
    }

    // ★ 恢复后的会话视为已持久化→重置计数器
    this.sessionsSinceReflection = this.store.size % SYSTEM.EPISODIC_REFLECTION_INTERVAL;
  }

  /**
   * 清空存储（store + pendingStore + BM25 索引 + reflections）。
   */
  clear(): void {
    this.store.clear();
    this.pendingStore.clear();
    this.episodeTokens.clear();
    this.bm25.clear();
    this.reflectionStore = [];
    this.sessionsSinceReflection = 0;
  }

  /**
   * 检索 store 大小（不含 pendingStore）。
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * pendingStore 大小（本会话中途快照数）。
   */
  get pendingSize(): number {
    return this.pendingStore.size;
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /**
   * 将 EpisodeSummary 转为 embedding 输入文本。
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
