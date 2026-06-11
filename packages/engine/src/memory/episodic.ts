/**
 * memory/episodic.ts — 情景记忆
 *
 * ★ 检索: 词级匹配——跨会话 <100 条摘要，子串+词匹配零延迟。
 *
 * 职责:
 *   1. 会话结束 → consolidate → EpisodeSummary
 *   2. 新会话开始 → retrieve → 词级匹配
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
import { extractAndParseJSON } from '../utils.js';

// ============================================================================
// §0 类型
// ============================================================================

export interface MetaEpisode {
  id: string;
  type: 'merged';
  mergedFiles: string[];
  commonDecisions: string[];
  tasks: string[];
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
}

function shareFiles(a: EpisodeSummary, b: EpisodeSummary): boolean {
  const filesA = new Set(
    (a.structuredSummary?.fileModifications ?? []).map((f) => f.path),
  );
  const filesB = b.structuredSummary?.fileModifications ?? [];
  return filesB.some((f) => filesA.has(f.path));
}

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
   * 会话结束时生成摘要。
   */
  async consolidate(
    session: SessionState,
    structuredSummary: StructuredSummary | null,
  ): Promise<EpisodeSummary> {
    const summary: EpisodeSummary = {
      id: session.id,
      timestamp: new Date().toISOString(),
      task: session.currentInput,
      outcome: session.outcome,
      structuredSummary,
      tokensUsed: session.tokensUsed,
      turns: session.turn,
    };

    this.pendingStore.set(summary.id, summary);
    return summary;
  }

  /** 合并 pendingStore → store + 触发跨会话合并 */
  commit(): void {
    for (const [id, summary] of this.pendingStore) {
      this.store.set(id, summary);
    }
    this.pendingStore.clear();
    this.sessionsSinceReflection++;

    // ★ 每积累 10 个会话后尝试合并相似条目
    if (this.store.size >= 10) {
      this.merge();
    }
  }

  // --------------------------------------------------------------------------
  // retrieve()
  // --------------------------------------------------------------------------

  /**
   * ★ 词级匹配检索——<100 条摘要，同步子串匹配零延迟。
   */
  async retrieve(
    userInput: string,
    topK: number = SYSTEM.EPISODIC_RETRIEVAL_TOPK,
  ): Promise<EpisodeSummary[]> {
    if (this.store.size === 0) return [];

    const queryLower = userInput.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1);

    const scored = [...this.store.values()]
      .map((ep) => {
        const haystack = serializeForScoring(ep).toLowerCase();
        let score = 0;
        if (haystack.includes(queryLower)) score += 10;
        for (const word of queryWords) {
          if (haystack.includes(word)) score += 1;
        }
        return { episode: ep, score };
      })
      .filter((s) => s.score > 0)
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

    const sessionTexts = recentSessions.map((s) => serializeForScoring(s));
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

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  serialize(): { episodes: string; reflections: string } {
    const all = [...this.store.values(), ...this.pendingStore.values()];
    return {
      episodes: JSON.stringify(all),
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

  // --------------------------------------------------------------------------
  // merge() — 跨会话合并
  // --------------------------------------------------------------------------

  /**
   * ★ 将相似会话合并为元条目，减少存储膨胀。
   *
   * 合并策略:
   *   1. 按共享文件分组——两个 session 操作了 >= 1 个相同文件 → 候选合并
   *   2. 合并组中提取共性: 共同文件路径 + 共同决策
   *   3. 原始条目被替换为 MetaEpisode——保留 count + 代表性摘要
   */
  merge(): void {
    const entries = [...this.store.values()];
    if (entries.length < 3) return;

    const merged = new Set<string>();
    const metaEpisodes: MetaEpisode[] = [];

    for (let i = 0; i < entries.length; i++) {
      if (merged.has(entries[i]!.id)) continue;
      const group: EpisodeSummary[] = [entries[i]!];

      for (let j = i + 1; j < entries.length; j++) {
        if (merged.has(entries[j]!.id)) continue;
        if (shareFiles(entries[i]!, entries[j]!)) {
          group.push(entries[j]!);
        }
      }

      if (group.length >= 2) {
        const allFiles = new Set<string>();
        const allDecisions = new Map<string, number>();
        for (const ep of group) {
          merged.add(ep.id);
          for (const f of ep.structuredSummary?.fileModifications ?? []) {
            allFiles.add(f.path);
          }
          for (const d of ep.structuredSummary?.decisions ?? []) {
            const key = d.what;
            allDecisions.set(key, (allDecisions.get(key) ?? 0) + 1);
          }
        }

        const commonDecisions = [...allDecisions.entries()]
          .filter(([, count]) => count >= 2)
          .map(([what]) => what);

        const timestamps = group.map((e) => e.timestamp).sort();
        const meta: MetaEpisode = {
          id: `merged-${group[0]!.id}`,
          type: 'merged',
          mergedFiles: [...allFiles],
          commonDecisions,
          tasks: group.map((e) => e.task),
          occurrenceCount: group.length,
          firstSeen: timestamps[0] ?? '',
          lastSeen: timestamps[timestamps.length - 1] ?? '',
        };
        metaEpisodes.push(meta);
      }
    }

    for (const id of merged) {
      this.store.delete(id);
    }
    for (const meta of metaEpisodes) {
      (this.store as Map<string, any>).set(meta.id, meta);
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

function serializeForScoring(summary: EpisodeSummary): string {
  const parts: string[] = [summary.task];
  if (summary.structuredSummary?.sessionIntent) {
    parts.push(summary.structuredSummary.sessionIntent);
  }
  if (summary.outcome) parts.push(summary.outcome);
  // Include file modifications and decisions for richer matching
  const files = summary.structuredSummary?.fileModifications?.map((f) => f.path) ?? [];
  if (files.length > 0) parts.push(files.join(' '));
  const decisions = summary.structuredSummary?.decisions?.map((d) => d.what) ?? [];
  if (decisions.length > 0) parts.push(decisions.join(' '));
  return parts.join(' | ');
}
