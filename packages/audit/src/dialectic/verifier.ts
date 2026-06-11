// ============================================================
// DialecticVerifier — AEGIS 四阶段审计编排器
//
// Phase I   — Clue Discovery (高召回，最坏污点假设)
// Phase II  — Evidence Chain (封闭证据集，数据流追踪)
// Phase III — Dialectical Verify (Red/Blue/裁决，每claim锚定行号)
// Phase IV  — Meta-Audit (独立审查，四类缺陷检测，可推翻)
//
// 循环内化: I → II (per clue, parallel) → III → IV (confirmed/warning only)
// ============================================================

import type { Finding, VerifiedFinding, Verdict } from '../finding.js';
import type { ToolCall } from '@comdr/core/types';
import { MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import { debug } from '../debug.js';
import {
  buildSingleVerifySystemPrompt,
  buildSingleVerifyUserPrompt,
  type RuleDefinition,
} from './prompts.js';
import type {
  ClueTuple,
  EvidenceChain,
  DialecticResult,
  MetaAuditResult,
  AuditedFinding,
} from './types.js';
import { DEFAULT_PHASE_CONFIG, type PhaseConfig } from './types.js';

// Phase modules
import { discoverClues } from './phase1-discover.js';
import { buildEvidenceChain } from './phase2-evidence.js';
import { dialecticVerify } from './phase3-dialectic.js';
import { metaAudit } from './phase4-audit.js';

import type { IToolExecutor } from '../tools/executor.js';
import { AUDIT_TOOLS, StandaloneToolExecutor } from '../tools/executor.js';
import { DeepSeekClient } from '@comdr/llm';

// ---- Types ----

export interface DialecticVerifierConfig {
  enabled: boolean;
  maxFindingsPerRun: number;
  maxFindingsPerBatch: number;
  /** Per-phase turn limits. Turn limits are safety guards against LLM tool-calling loops — not arbitrary caps. */
  phases: PhaseConfig;
}

const DEFAULT_CONFIG: DialecticVerifierConfig = {
  enabled: true,
  maxFindingsPerRun: 50,
  maxFindingsPerBatch: 10,
  phases: DEFAULT_PHASE_CONFIG,
};

// ---- Severity order for prioritization ----

const SEV_ORDER: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** Max concurrent LLM calls in Phase II. Prevents API rate-limit flood. */
const CONCURRENCY_LIMIT = 5;

// ---- Verifier ----

export class DialecticVerifier {
  private config: DialecticVerifierConfig;
  private llm: IDeepSeekClient | null;
  private tools: IToolExecutor | null;

  constructor(
    config?: Partial<DialecticVerifierConfig>,
    llm?: IDeepSeekClient,
    tools?: IToolExecutor,
  ) {
    this.config = mergeConfig(DEFAULT_CONFIG, config);
    this.llm = llm ?? null;
    this.tools = tools ?? null;
  }

  setLLM(llm: IDeepSeekClient, tools: IToolExecutor): void {
    this.llm = llm;
    this.tools = tools;
  }

  static fromEnv(
    projectRoot: string,
    config?: Partial<DialecticVerifierConfig>,
  ): DialecticVerifier {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY environment variable is required. ' +
          'Set it and retry. No fallback available — audit requires LLM.',
      );
    }
    const dsClient = new DeepSeekClient({
      apiKey,
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      maxTokens: 2000,
      thinking: { type: THINKING_TYPE.DISABLED },
    });
    const tools = new StandaloneToolExecutor(projectRoot);
    return new DialecticVerifier(config, dsClient, tools);
  }

  // ================================================================
  // Main Pipeline: discoverRules (I → II → III → IV)
  // ================================================================

  /**
   * Full AEGIS pipeline: discover clues from rules, build evidence chains,
   * run dialectic verification, and meta-audit.
   */
  async discoverRules(
    rules: RuleDefinition[],
    projectRoot: string,
    files?: string[],
  ): Promise<AuditedFinding[]> {
    if (!this.llm || !this.tools) {
      throw new Error('LLM not configured. Call setLLM() or use fromEnv().');
    }

    const llm = this.llm;
    const tools = this.tools;
    const pc = this.config.phases;
    const allFindings: AuditedFinding[] = [];

    // ---- Phase I: Clue Discovery ----
    debug.info('llm', `Phase I: Discovering clues for ${rules.length} rules...`);
    const { clues, tokenUsage: t1 } = await discoverClues(
      llm,
      tools,
      rules,
      projectRoot,
      pc.discover.maxToolTurns,
      files,
    );
    debug.info('llm', `Phase I: ${clues.length} clues found (${t1.total} tokens)`);

    if (clues.length === 0) return [];

    // Prioritize: security > quality, critical > low, higher confidence first
    const prioritized = [...clues]
      .sort((a, b) => {
        const aScore =
          (a.category === 'security' ? 10 : 0) +
          (SEV_ORDER[a.severity] || 0) * 2 +
          a.confidence * 5;
        const bScore =
          (b.category === 'security' ? 10 : 0) +
          (SEV_ORDER[b.severity] || 0) * 2 +
          b.confidence * 5;
        return bScore - aScore;
      })
      .slice(0, this.config.maxFindingsPerRun);

    debug.info('llm', `Prioritized to ${prioritized.length} clues for deep analysis`);

    // ---- Phase II: Evidence Chain (parallel per clue) ----
    let totalTokens = t1.total;

    if (!pc.evidence.enabled) {
      // Skip evidence chain — go straight to dialectic with empty chain
      for (const clue of prioritized) {
        const emptyChain: EvidenceChain = {
          clueId: clue.id,
          backwardChain: [],
          forwardChain: [],
          protectionsFound: [],
          protectionsMissing: [],
          crossFileBoundaries: [],
          isComplete: false,
        };
        const finding = await this.runPhase345(llm, clue, emptyChain, totalTokens);
        allFindings.push(finding);
        totalTokens += finding.tokenUsage?.total || 0;
      }
      return allFindings;
    }

    // Run Phase II with concurrency limit + allSettled (one failure doesn't kill all)
    debug.info('llm', `Phase II: Building evidence chains for ${prioritized.length} clues...`);
    const evidenceResults = await runWithConcurrency(
      prioritized,
      (clue) => buildEvidenceChain(llm, tools, clue, pc.evidence.maxToolTurns),
      CONCURRENCY_LIMIT,
    );

    // ---- Phase III + IV per clue ----
    for (let i = 0; i < prioritized.length; i++) {
      const clue = prioritized[i]!;
      const settled = evidenceResults[i]!;

      if (settled.status === 'rejected') {
        debug.error('llm', `Phase II: failed for clue ${clue.id}`, settled.reason);
        totalTokens += 0; // no token data from failed calls
        allFindings.push(fallbackAuditedFinding(clue, `Phase II error: ${String(settled.reason).slice(0, 100)}`));
        continue;
      }

      const evResult = settled.value;
      totalTokens += evResult.tokenUsage.total;

      const chain = evResult.chain;
      if (!chain) {
        debug.warn('llm', `Phase II: no chain for clue ${clue.id}, skipping`);
        allFindings.push(fallbackAuditedFinding(clue, 'Phase II produced no chain'));
        continue;
      }

      debug.info(
        'llm',
        `Clue ${clue.id}: chain ${chain.backwardChain.length}B/${chain.forwardChain.length}F, ` +
          `${chain.protectionsFound.length}p found, ${chain.protectionsMissing.length}p missing`,
      );

      const finding = await this.runPhase345(llm, clue, chain, totalTokens);
      allFindings.push(finding);
      totalTokens += finding.tokenUsage?.total || 0;
    }

    debug.info(
      'llm',
      `Pipeline complete: ${allFindings.length} findings, ${totalTokens} total tokens`,
    );
    return allFindings;
  }

  /**
   * Run Phase III (dialectic) + Phase IV (meta-audit, with retry) for one clue.
   */
  private async runPhase345(
    llm: IDeepSeekClient,
    clue: ClueTuple,
    chain: EvidenceChain,
    tokensSoFar: number,
  ): Promise<AuditedFinding> {
    const pc = this.config.phases;
    let phaseTokens = 0;

    // ---- Phase III: Dialectic ----
    let dr: DialecticResult;
    if (pc.dialectic.enabled) {
      const result = await dialecticVerify(llm, clue, chain);
      dr = result.result;
      phaseTokens += result.tokenUsage.total;
    } else {
      dr = {
        factualBasis: 'Dialectic phase disabled.',
        attackSteps: [],
        defenseArgs: [],
        adjudication: {
          verdict: 'warning',
          confidence: 0.5,
          decisiveEvidence: [],
          reasoning: 'Dialectic verification skipped (phase disabled).',
        },
      };
    }

    // ---- Phase IV: Meta-Audit (only confirmed/warning) ----
    let ma: MetaAuditResult | undefined;
    if (
      pc.metaAudit.enabled &&
      pc.metaAudit.requireFor.includes(dr.adjudication.verdict)
    ) {
      const auditResult = await metaAudit(llm, clue, chain, dr);
      ma = auditResult.result;
      phaseTokens += auditResult.tokenUsage.total;

      // If disagree, re-run Phase III with audit flaws as context
      if (ma.judgment === 'disagree' && ma.flaws.length > 0) {
        debug.warn(
          'llm',
          `Phase IV disagreed on ${clue.id}: ${ma.flaws.map((f) => f.category).join(', ')}. Re-running Phase III.`,
        );
        const retryResult = await dialecticVerify(llm, clue, chain);
        dr = retryResult.result;
        phaseTokens += retryResult.tokenUsage.total;
      }
    }

    return this.toAuditedFinding(clue, chain, dr, ma, phaseTokens);
  }

  /**
   * Build the final AuditedFinding from all phase results.
   */
  private toAuditedFinding(
    clue: ClueTuple,
    chain: EvidenceChain,
    dr: DialecticResult,
    ma: MetaAuditResult | undefined,
    phaseTokens: number,
  ): AuditedFinding {
    const finding: Finding = {
      id: `audit-${clue.id}`,
      severity: clue.severity,
      category: clue.category,
      title: `${clue.rule.split('/').pop() || clue.rule} at ${clue.file}:${clue.line}`,
      description: clue.whySuspicious,
      file: clue.file,
      line: clue.line,
      snippet: clue.statement,
      rule: clue.rule,
      confidence: dr.adjudication.confidence,
      source: 'llm',
    };

    return {
      finding,
      verdict: dr.adjudication.verdict,
      confidence: dr.adjudication.confidence,
      decisiveEvidence: dr.adjudication.decisiveEvidence,
      reasoning: dr.adjudication.reasoning,
      mode: 'llm',
      phase: ma ? 4 : 3,
      evidenceChain: chain,
      dialecticResult: dr,
      metaAudit: ma,
      tokenUsage: { total: phaseTokens },
    };
  }

  // ================================================================
  // Single-Finding Verify (ad-hoc / backward compat)
  // ================================================================

  async verify(finding: Finding): Promise<VerifiedFinding> {
    if (!this.llm || !this.tools) {
      throw new Error('LLM not configured.');
    }

    const systemPrompt = buildSingleVerifySystemPrompt(finding);
    const userPrompt = buildSingleVerifyUserPrompt(finding);

    const messages: Array<{
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      reasoning_content?: string;
    }> = [
      { role: MESSAGE_ROLE.SYSTEM, content: systemPrompt },
      { role: MESSAGE_ROLE.USER, content: userPrompt },
    ];

    let totalTokens = 0;

    for (let turn = 0; turn < 5; turn++) {
      const resp = await this.llm.chat({
        messages: messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.content,
        })),
        tools: AUDIT_TOOLS,
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: 2000,
      });

      totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;

      if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
        const verdict = this.parseVerdict(resp.message.content);
        return {
          finding,
          verdict: verdict.verdict as Verdict,
          confidence: verdict.confidence,
          decisiveEvidence: verdict.decisiveEvidence,
          reasoning: verdict.reasoning,
          mode: 'llm',
          tokenUsage: { total: totalTokens },
        };
      }

      messages.push({
        role: MESSAGE_ROLE.ASSISTANT,
        content: resp.message.content,
        tool_calls: resp.message.tool_calls,
        reasoning_content: resp.message.reasoning_content,
      });

      for (const tc of resp.message.tool_calls) {
        try {
          const result = await this.tools.execute(tc);
          messages.push({ role: 'tool', content: result.content, tool_call_id: tc.id });
        } catch (err) {
          messages.push({
            role: 'tool',
            content: `Tool error: ${String(err).slice(0, 200)}`,
            tool_call_id: tc.id,
          });
        }
      }
    }

    // Force verdict
    messages.push({
      role: MESSAGE_ROLE.USER,
      content: 'Max tool calls reached. Output your verdict as JSON now.',
    });

    const resp = await this.llm.chat({
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
      thinking: { type: THINKING_TYPE.DISABLED },
      maxTokens: 500,
    });

    totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;
    const verdict = this.parseVerdict(resp.message.content);

    return {
      finding,
      verdict: verdict.verdict as Verdict,
      confidence: verdict.confidence,
      decisiveEvidence: verdict.decisiveEvidence,
      reasoning: verdict.reasoning,
      mode: 'llm',
      tokenUsage: { total: totalTokens },
    };
  }

  // ================================================================
  // Batch Verify (pre-existing findings from external source)
  // ================================================================

  async verifyBatch(findings: Finding[]): Promise<VerifiedFinding[]> {
    if (!this.llm || !this.tools) throw new Error('LLM not configured.');
    if (findings.length === 0) return [];

    const byRule = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = byRule.get(f.rule);
      if (list) list.push(f);
      else byRule.set(f.rule, [f]);
    }

    const results: VerifiedFinding[] = [];
    for (const [, sameRuleFindings] of byRule) {
      for (let i = 0; i < sameRuleFindings.length; i += this.config.maxFindingsPerBatch) {
        const chunk = sameRuleFindings.slice(i, i + this.config.maxFindingsPerBatch);
        results.push(...(await this.verifySameRuleBatch(chunk)));
      }
    }
    return results;
  }

  private async verifySameRuleBatch(findings: Finding[]): Promise<VerifiedFinding[]> {
    if (findings.length === 0) return [];

    const first = findings[0]!;
    const systemPrompt = [
      'You are a code security auditor. Verify the following findings using read-only tools.',
      `<rule>${first.rule} — ${first.severity}</rule>`,
      '<description>' + first.description + '</description>',
      'For each finding, investigate and output a JSON array:',
      '[ { "findingIndex": 0, "verdict": "confirmed"|"warning"|"dismissed", "confidence": 0.0, "decisiveEvidence": [...], "reasoning": "..." }, ... ]',
    ].join('\n');

    const userPrompt = [
      `${findings.length} findings to verify:`,
      ...findings.map(
        (f, i) =>
          `<finding index="${i}"><title>${f.title}</title><file>${f.file}:${f.line}</file><snippet>${f.snippet.slice(0, 200)}</snippet></finding>`,
      ),
      'Investigate each and output verdicts.',
    ].join('\n');

    const messages: Array<{
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      reasoning_content?: string;
    }> = [
      { role: MESSAGE_ROLE.SYSTEM, content: systemPrompt },
      { role: MESSAGE_ROLE.USER, content: userPrompt },
    ];

    let totalTokens = 0;

    for (let turn = 0; turn < 5; turn++) {
      const resp = await this.llm!.chat({
        messages: messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.content,
        })),
        tools: AUDIT_TOOLS,
        thinking: { type: THINKING_TYPE.DISABLED },
        maxTokens: 2000,
      });

      totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;

      if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
        const verdictMap = parseBatchVerdict(resp.message.content, findings.length);
        return verdictMapToFindings(findings, verdictMap, totalTokens);
      }

      messages.push({
        role: MESSAGE_ROLE.ASSISTANT,
        content: resp.message.content,
        tool_calls: resp.message.tool_calls,
        reasoning_content: resp.message.reasoning_content,
      });

      for (const tc of resp.message.tool_calls) {
        try {
          const r = await this.tools!.execute(tc);
          messages.push({ role: 'tool', content: r.content, tool_call_id: tc.id });
        } catch (err) {
          messages.push({
            role: 'tool',
            content: `Tool error: ${String(err).slice(0, 200)}`,
            tool_call_id: tc.id,
          });
        }
      }
    }

    messages.push({
      role: MESSAGE_ROLE.USER,
      content: 'Max tool calls reached. Output your verdict JSON array now.',
    });

    const resp = await this.llm!.chat({
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
      thinking: { type: THINKING_TYPE.DISABLED },
      maxTokens: Math.max(500, findings.length * 200),
    });

    totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;
    const verdictMap = parseBatchVerdict(resp.message.content, findings.length);
    return verdictMapToFindings(findings, verdictMap, totalTokens);
  }

  // ================================================================
  // Parsers
  // ================================================================

  private parseVerdict(content: string | null): {
    verdict: string;
    confidence: number;
    decisiveEvidence: string[];
    reasoning: string;
  } {
    const text = content ?? '';
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch?.[1]?.trim() ?? text.trim();
    try {
      return JSON.parse(jsonStr);
    } catch {
      debug.error('llm', `parseVerdict: JSON parse error on: ${text.slice(0, 200)}`);
      return {
        verdict: 'warning',
        confidence: 0,
        decisiveEvidence: ['⚠ PARSE ERROR — LLM output was not valid JSON. Manual review required.'],
        reasoning: `Raw response: ${text.slice(0, 300)}`,
      };
    }
  }
}

// ================================================================
// Helpers
// ================================================================

/**
 * Run async tasks with a concurrency cap.
 * Uses allSettled so one failure doesn't cascade-kill all others.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }>> {
  const results: Array<{ status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown }> = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(
      ...chunkResults.map((r) =>
        r.status === 'fulfilled'
          ? { status: 'fulfilled' as const, value: r.value }
          : { status: 'rejected' as const, reason: r.reason },
      ),
    );
  }
  return results;
}

function mergeConfig(
  base: DialecticVerifierConfig,
  override?: Partial<DialecticVerifierConfig>,
): DialecticVerifierConfig {
  if (!override) return { ...base };
  return {
    ...base,
    ...override,
    phases: {
      ...base.phases,
      ...(override.phases || {}),
      discover: { ...base.phases.discover, ...(override.phases?.discover || {}) },
      evidence: { ...base.phases.evidence, ...(override.phases?.evidence || {}) },
      dialectic: { ...base.phases.dialectic, ...(override.phases?.dialectic || {}) },
      metaAudit: { ...base.phases.metaAudit, ...(override.phases?.metaAudit || {}) },
    },
  };
}

function fallbackAuditedFinding(clue: ClueTuple, reason: string): AuditedFinding {
  return {
    finding: {
      id: `audit-${clue.id}`,
      severity: clue.severity,
      category: clue.category,
      title: clue.whySuspicious,
      description: clue.whySuspicious,
      file: clue.file,
      line: clue.line,
      snippet: clue.statement,
      rule: clue.rule,
      confidence: 0.5,
      source: 'llm',
    },
    verdict: 'warning',
    confidence: 0.5,
    decisiveEvidence: [reason],
    reasoning: `Evidence chain construction failed: ${reason}`,
    mode: 'llm',
    phase: 2,
  };
}

function parseBatchVerdict(
  content: string | null,
  findingCount: number,
): Map<number, { verdict: string; confidence: number; decisiveEvidence: string[]; reasoning: string }> {
  const map = new Map<
    number,
    { verdict: string; confidence: number; decisiveEvidence: string[]; reasoning: string }
  >();
  const text = content ?? '';

  try {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const arrayStr = (fenceMatch?.[1]?.trim() ?? text.trim()).match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!arrayStr) return map;

    const entries = JSON.parse(arrayStr[0]) as Array<{
      findingIndex: number;
      verdict: string;
      confidence: number;
      decisiveEvidence: string[];
      reasoning: string;
    }>;

    for (const e of entries) {
      if (typeof e.findingIndex !== 'number' || e.findingIndex < 0 || e.findingIndex >= findingCount)
        continue;
      if (!['confirmed', 'warning', 'dismissed'].includes(e.verdict)) continue;
      map.set(e.findingIndex, {
        verdict: e.verdict,
        confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.5,
        decisiveEvidence: Array.isArray(e.decisiveEvidence) ? e.decisiveEvidence : [],
        reasoning: e.reasoning || 'No reasoning provided.',
      });
    }
  } catch (err) {
    debug.error('llm', `parseBatchVerdict: JSON parse error: ${String(err).slice(0, 200)}`);
  }

  return map;
}

function verdictMapToFindings(
  findings: Finding[],
  map: Map<number, { verdict: string; confidence: number; decisiveEvidence: string[]; reasoning: string }>,
  totalTokens: number,
): VerifiedFinding[] {
  const perToken = Math.floor(totalTokens / findings.length);
  return findings.map((f, i) => {
    const v = map.get(i);
    return {
      finding: f,
      verdict: (v?.verdict ?? 'warning') as Verdict,
      confidence: v?.confidence ?? 0.5,
      decisiveEvidence: v?.decisiveEvidence ?? ['No verdict returned.'],
      reasoning: v?.reasoning ?? 'Verification incomplete.',
      mode: 'llm' as const,
      tokenUsage: { total: perToken },
    };
  });
}

// ================================================================
// Report Formatting
// ================================================================

export function formatVerifiedFinding(
  result: VerifiedFinding | AuditedFinding,
): string {
  const icon: Record<Verdict, string> = {
    confirmed: '🔴 CONFIRMED',
    warning: '🟡 WARNING',
    dismissed: '🟢 DISMISSED',
  };

  const lines = [
    `${icon[result.verdict]} | ${result.finding.severity.toUpperCase()} | ${result.finding.category}`,
    `  Title: ${result.finding.title}`,
    `  File: ${result.finding.file}:${result.finding.line}`,
    `  Rule: ${result.finding.rule} (confidence: ${result.confidence.toFixed(2)})`,
    `  Reasoning: ${result.reasoning}`,
    ...result.decisiveEvidence.map((e) => `    - ${e}`),
    result.finding.suggestion ? `  Suggestion: ${result.finding.suggestion}` : '',
  ];

  // Show evidence chain summary if available
  const audited = result as AuditedFinding;
  if (audited.evidenceChain) {
    const ec = audited.evidenceChain;
    lines.push(`  Evidence: ${ec.backwardChain.length}B/${ec.forwardChain.length}F nodes, ${ec.protectionsFound.length} protections found, ${ec.protectionsMissing.length} missing`);
    if (audited.metaAudit) {
      const ma = audited.metaAudit;
      lines.push(
        `  Meta-Audit: ${ma.judgment}${ma.flaws.length > 0 ? ` (${ma.flaws.length} flaws: ${ma.flaws.map((f) => f.category).join(', ')})` : ''}`,
      );
    }
  }

  lines.push('');
  return lines.filter((l) => l !== '').join('\n');
}

export function generateVerificationReport(
  results: (VerifiedFinding | AuditedFinding)[],
): string {
  const confirmed = results.filter((r) => r.verdict === 'confirmed');
  const warnings = results.filter((r) => r.verdict === 'warning');
  const dismissed = results.filter((r) => r.verdict === 'dismissed');
  const tokenTotal = results.reduce((s, r) => s + (r.tokenUsage?.total || 0), 0);

  // Count phases
  const audited = results.filter((r) => 'phase' in r) as AuditedFinding[];
  const withEvidence = audited.filter((r) => r.evidenceChain).length;
  const withMetaAudit = audited.filter((r) => r.metaAudit).length;
  const metaDisagreed = audited.filter((r) => r.metaAudit?.judgment === 'disagree').length;

  const lines = [
    '='.repeat(60),
    '  Comdr-Audit Report (AEGIS Pipeline)',
    '='.repeat(60),
    '',
    `Total: ${results.length} | 🔴 ${confirmed.length} | 🟡 ${warnings.length} | 🟢 ${dismissed.length}`,
    `Mode: LLM (4-phase) | Tokens: ${tokenTotal}`,
    audited.length > 0
      ? `Phases: ${withEvidence} with evidence chain, ${withMetaAudit} meta-audited${metaDisagreed > 0 ? `, ${metaDisagreed} vetoed` : ''}`
      : '',
    '',
    '-'.repeat(60),
    '',
  ];

  for (const r of [...confirmed, ...warnings, ...dismissed]) {
    lines.push(formatVerifiedFinding(r));
  }

  lines.push('-'.repeat(60));
  return lines.join('\n');
}
