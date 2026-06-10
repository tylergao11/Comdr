/**
 * memory/procedural.ts — 跨项目模式记忆
 *
 * ★ 渐进式记忆第四层——从多个项目的成功 session 中提取通用模式。
 *
 * 来源: SuperLocalMemory (2026) — Bayesian trust scoring + 跨项目模式提取。
 *       SOLAR (2025) — lifelong learning without gradient updates。
 *       Generative Agents (2023) — reflection 层 → plan。
 *
 * 信任模型:
 *   trust = 0.5 (初始)
 *   reinforce: trust += 0.1 (同一模式在另一个项目再次出现)
 *   contradict: trust -= 0.3 (模式被证伪)
 *   trust < 0.3 → 淘汰
 *   trust ≥ 0.7 → 标记为 "confirmed"，注入 prompt
 *
 * @agent Agent 4 — 此文件由 Agent 4 维护
 */

import { readdirSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EpisodeSummary, StructuredSummary } from '@comdr/core/types';
import { MESSAGE_ROLE, THINKING_TYPE, SYSTEM } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import { extractAndParseJSON } from '../utils.js';

// ============================================================================
// §1 类型
// ============================================================================

export interface ProceduralPattern {
  id: string;
  /** 模式描述（人类可读） */
  pattern: string;
  /** 证据：支撑此模式的来源（project:sessionId） */
  evidence: string[];
  /** Bayesian trust 0-1 */
  trust: number;
  /** 适用条件（哪些编程语言/框架） */
  context?: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

// ============================================================================
// §2 ProceduralMemory 类
// ============================================================================

export class ProceduralMemory {
  private patterns: Map<string, ProceduralPattern> = new Map();
  /** 存储路径 */
  private readonly storePath: string;
  /** 跨项目 pattern 提取的最小 session 数 */
  private static readonly MIN_SESSIONS_FOR_PATTERN = 3;
  /** reinforce: 同模式再次出现 +0.1 */
  private static readonly REINFORCE_DELTA = 0.1;
  /** contradict: 模式被证伪 -0.3 */
  private static readonly CONTRADICT_DELTA = 0.3;
  /** 信任阈值: 低于此值淘汰 */
  private static readonly TRUST_EVICTION = 0.3;
  /** 信任阈值: 高于此值注入 prompt */
  private static readonly TRUST_CONFIRMED = 0.7;

  constructor(storePath?: string) {
    this.storePath = storePath ?? join(homedir(), '.comdr', 'procedural.json');
  }

  // --------------------------------------------------------------------------
  // 模式提取
  // --------------------------------------------------------------------------

  /**
   * Scan cross-project episodic data and extract general patterns.
   * Requires at least MIN_SESSIONS_FOR_PATTERN successful sessions.
   */
  async learn(llm: IDeepSeekClient): Promise<ProceduralPattern[]> {
    const episodes = this.collectCrossProjectEpisodes();
    if (episodes.length < ProceduralMemory.MIN_SESSIONS_FOR_PATTERN) return [];

    const prompt = this.buildExtractionPrompt(episodes);
    try {
      const response = await llm.chat({
        messages: [{ role: MESSAGE_ROLE.SYSTEM, content: prompt }],
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: 1024,
      });

      const content = response.message.content;
      if (content) {
        const parsed = extractAndParseJSON<{
          patterns: { pattern: string; evidence: string[]; context?: string }[];
        }>(content);
        if (parsed?.patterns?.length) {
          const newPatterns = parsed.patterns.map((p) =>
            this.upsert(p.pattern, p.evidence, p.context),
          );
          this.evictLowTrust();
          this.save();
          return newPatterns;
        }
      }
    } catch {
      // 提取失败 → 静默降级
    }
    return [];
  }

  /** 收集跨项目 episodic 数据 */
  private collectCrossProjectEpisodes(): EpisodeSummary[] {
    const all: EpisodeSummary[] = [];
    const projectsDir = join(homedir(), '.comdr', 'projects');
    if (!existsSync(projectsDir)) return all;

    try {
      for (const dir of readdirSync(projectsDir)) {
        const epPath = join(projectsDir, dir, 'temp', 'comdr', 'sessions', 'episodic.json');
        if (!existsSync(epPath)) continue;
        try {
          const raw = JSON.parse(readFileSync(epPath, 'utf-8')) as {
            episodes: string; reflections: string;
          };
          const episodes = JSON.parse(
            raw.episodes || '[]',
          ) as EpisodeSummary[];
          // 只取成功的 session
          for (const ep of episodes) {
            if (ep.outcome === 'completed' && ep.turns > 1) {
              all.push(ep);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return all;
  }

  /** 构建提取 prompt */
  private buildExtractionPrompt(episodes: EpisodeSummary[]): string {
    const summaries = episodes.slice(0, 20).map((ep) => {
      const ss = ep.structuredSummary;
      const files = ss?.fileModifications?.map((f) => f.action + ' ' + f.path) ?? [];
      const decisions = ss?.decisions?.map((d) => d.what) ?? [];
      return '- [' + ep.id.slice(0, 8) + '] ' + ep.task + ' -> ' + ep.outcome + ' | files: ' + files.join(', ') + ' | decisions: ' + decisions.join('; ');
    }).join('\n');

    return [
      'You are a pattern extraction engine. Given summaries of SUCCESSFUL coding sessions across different projects, identify GENERAL patterns that are worth reusing.',
      'Focus on: (1) strategies that worked, (2) common pitfalls, (3) file modification patterns.',
      'Ignore project-specific details (file names, library choices).',
      'Output ONLY valid JSON:',
      '{ "patterns": [',
      '  {"pattern": "description", "evidence": ["id1","id2","id3"], "context": "optional"}',
      '] }',
      'A pattern must have ≥ 3 evidence sessions to be included.',
      '',
      'Session summaries:',
      summaries,
    ].join('\n');
  }

  // --------------------------------------------------------------------------
  // 信任管理
  // --------------------------------------------------------------------------

  /** 新增或 reinforce 已有模式 */
  upsert(pattern: string, evidence: string[], context?: string): ProceduralPattern {
    const key = this.patternKey(pattern);
    const existing = this.patterns.get(key);
    if (existing) {
      // ★ reinforce: 同模式再次出现 → 信任增加
      existing.trust = Math.min(1, existing.trust + ProceduralMemory.REINFORCE_DELTA);
      existing.evidence = [...new Set([...existing.evidence, ...evidence])];
      if (context) existing.context = context;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    // 新模式
    const entry: ProceduralPattern = {
      id: key,
      pattern,
      evidence,
      trust: 0.5,
      context,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.patterns.set(key, entry);
    return entry;
  }

  /** 反证: 模式被证伪 → 信任降低 */
  contradict(pattern: string): void {
    const key = this.patternKey(pattern);
    const existing = this.patterns.get(key);
    if (existing) {
      existing.trust = Math.max(0, existing.trust - ProceduralMemory.CONTRADICT_DELTA);
      existing.updatedAt = new Date().toISOString();
    }
  }

  /** 淘汰低信任模式 */
  private evictLowTrust(): void {
    for (const [key, p] of this.patterns) {
      if (p.trust < ProceduralMemory.TRUST_EVICTION) {
        this.patterns.delete(key);
      }
    }
  }

  /** 获取确认的模式（trust ≥ 0.7） */
  getConfirmed(): ProceduralPattern[] {
    return [...this.patterns.values()]
      .filter((p) => p.trust >= ProceduralMemory.TRUST_CONFIRMED)
      .sort((a, b) => b.trust - a.trust);
  }

  private patternKey(pattern: string): string {
    // 简单哈希: 取前 50 字符的稳定 key
    return pattern.slice(0, 50).toLowerCase().replace(/\s+/g, '-');
  }

  // --------------------------------------------------------------------------
  // 持久化
  // --------------------------------------------------------------------------

  save(): void {
    try {
      const dir = this.storePath.replace(/\/[^/]+$/, '');
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.storePath, JSON.stringify([...this.patterns.values()], null, 2), 'utf-8');
    } catch { /* 静默降级 */ }
  }

  load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const arr = JSON.parse(readFileSync(this.storePath, 'utf-8')) as ProceduralPattern[];
      this.patterns = new Map(arr.map((p) => [p.id, p]));
    } catch { /* 数据损坏 → 静默跳过 */ }
  }

  clear(): void {
    this.patterns.clear();
  }
}
