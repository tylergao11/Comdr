/**
 * memory/episodic.ts — 情景记忆
 *
 * ★ 检索: 字符 trigram 向量 + cosine similarity（零模型、零正则）。
 *   查询扩展: 外部 flash LLM 将中文扩展为英文检索词（可选优化）。
 *
 * 职责:
 *   1. 会话结束 → consolidate → EpisodeSummary + trigram vector
 *   2. 新会话开始 → retrieve → trigram cosine similarity
 *   3. 跨会话反思 → reflect → 每 N 个会话触发
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
import { textToVector, cosineSimilarity } from '../trigram-index.js';
import { extractAndParseJSON } from '../utils.js';

// ============================================================================
// §1 EpisodicMemory 类
// ============================================================================

export class EpisodicMemory {
  /** 检索 store——仅含之前会话的摘要 */
  private store: Map<string, EpisodeSummary> = new Map();
  /** 当前会话摘要——commit() 前与 store 隔离 */
  private pendingStore: Map<string, EpisodeSummary> = new Map();
  /** 已完成但尚未反思的会话计数 */
  private sessionsSinceReflection = 0;

  // --------------------------------------------------------------------------
  // consolidate()
  // --------------------------------------------------------------------------

  /**
   * 会话结束时生成摘要 + trigram vector。
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

    const text = serializeForEmbedding(summary);
    summary.embedding = Array.from(textToVector(text));

    this.pendingStore.set(summary.id, summary);
    return summary;
  }

  /** 合并 pendingStore → store */
  commit(): void {
    for (const [id, summary] of this.pendingStore) {
      this.store.set(id, summary);
    }
    this.pendingStore.clear();
    this.sessionsSinceReflection++;
  }

  // --------------------------------------------------------------------------
  // retrieve()
  // --------------------------------------------------------------------------

  /**
   * ★ Trigram 向量检索。
   *
   * @param userInput    用户输入（可经 QueryExpander 扩展）
   * @param topK         top-K
   * @param taskType     同类型历史加权
   * @param episodeBoost boost 系数
   */
  retrieve(
    userInput: string,
    topK: number = SYSTEM.EPISODIC_RETRIEVAL_TOPK,
  ): EpisodeSummary[] {
    if (this.store.size === 0) return [];

    const queryVec = textToVector(userInput);

    const scored = [...this.store.values()]
      .map((ep) => {
        if (!ep.embedding || ep.embedding.length === 0) {
          return { episode: ep, score: 0 };
        }
        return {
          episode: ep,
          score: cosineSimilarity(queryVec, new Float32Array(ep.embedding)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map((s) => s.episode);
  }

  // --------------------------------------------------------------------------
  // 跨会话反思
  // --------------------------------------------------------------------------

  async reflect(
    recentSessions: EpisodeSummary[],
    llm: IDeepSeekClient,
  ): Promise<ReflectionEntry[]> {
    if (recentSessions.length === 0) return [];

    const sessionTexts = recentSessions.map((s) => serializeForEmbedding(s));
    const prompt = [
      'Analyze coding sessions. Identify repeated failure modes, successful strategies,',
      'and frequently co-modified files.',
      'Respond as JSON array:',
      '[{"type":"failure_mode"|"success_strategy"|"co_modified","insight":"...","confidence":0.X}]',
      '',
      'Sessions:',
      ...sessionTexts.map((t, i) => `[${i}] ${t}`),
    ].join('\n');

    try {
      const response = await llm.chat({
        messages: [{ role: MESSAGE_ROLE.USER, content: prompt }],
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: 1024,
      });
      const raw = response.message.content ?? '';
      const parsed = extractAndParseJSON<ReflectionEntry[]>(raw);
      return Array.isArray(parsed)
        ? parsed.filter((r) => (r.confidence ?? 0) > 0.5)
        : [];
    } catch {
      return [];
    }
  }

  getReflections(): ReflectionEntry[] {
    return []; // 由外部持久化层管理
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  serialize(): { episodes: string; reflections: string } {
    const all = [...this.store.values(), ...this.pendingStore.values()];
    const summaries = all.map(({ embedding: _, ...rest }) => rest);
    return {
      episodes: JSON.stringify(summaries),
      reflections: JSON.stringify([]),
    };
  }

  deserialize(data: { episodes: string; reflections: string }): void {
    try {
      const eps: EpisodeSummary[] = JSON.parse(data.episodes || '[]');
      this.store.clear();
      for (const ep of eps) {
        this.store.set(ep.id, ep);
      }
    } catch {
      // 静默降级
    }
  }
}

// ============================================================================
// §2 工厂
// ============================================================================

export function createEpisodicMemory(data?: {
  episodes: string;
  reflections: string;
}): EpisodicMemory {
  const memory = new EpisodicMemory();
  if (data) memory.deserialize(data);
  return memory;
}

// ============================================================================
// §3 辅助
// ============================================================================

function serializeForEmbedding(summary: EpisodeSummary): string {
  const parts: string[] = [summary.task];
  if (summary.structuredSummary?.sessionIntent) {
    parts.push(summary.structuredSummary.sessionIntent);
  }
  if (summary.outcome) parts.push(summary.outcome);
  return parts.join(' | ');
}
