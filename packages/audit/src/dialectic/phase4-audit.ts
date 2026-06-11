// ============================================================
// Phase IV — Meta-Audit (AEGIS: Independent Reasoning Audit)
//
// ★ 独立审查 Phase III 裁决的推理质量。四类缺陷检测。
//   发现具体缺陷 → disagree + 回退 Phase III 重判。
//   无具体缺陷 → agree / defer。
// ============================================================

import { MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import type {
  ClueTuple,
  EvidenceChain,
  DialecticResult,
  MetaAuditResult,
  ReasoningFlaw,
  FlawCategory,
} from './types.js';
import { debug } from '../debug.js';

// ---- Prompt ----

function formatEvidenceSummary(chain: EvidenceChain): string {
  const allNodes = [...chain.backwardChain, ...chain.forwardChain, ...chain.protectionsFound];
  return allNodes
    .map((n) => `  ${n.file}:${n.line} [${n.role}] ${n.code.slice(0, 100)} — ${n.description}`)
    .join('\n');
}

function buildMetaAuditSystemPrompt(): string {
  return [
    '## ROLE',
    'You are a META-AUDITOR. Your job is to audit the REASONING of a previous',
    'verification step — NOT to re-verify the code itself.',
    '',
    'You will receive:',
    '1. An evidence chain (the closed set of facts)',
    '2. A dialectic verification result (factual basis, attack, defense, adjudication)',
    '',
    'Your job: find FLAWS in the reasoning. You are not re-judging the code.',
    'You are checking whether the Phase III verifier violated the evidence boundary.',
    '',
    '## FOUR FLAW CATEGORIES (from AEGIS)',
    '',
    '### 1. Phantom Mitigation',
    'The verifier claimed a protection exists that is NOT in the evidence chain.',
    'Example: "The code sanitizes input at line 20" — but line 20 is not in the chain.',
    'Check: For every defense argument, is the cited file:line actually in the chain?',
    '',
    '### 2. Speculation',
    'The verifier made claims about code OUTSIDE the evidence chain.',
    'Example: "The caller probably validates this" — but the caller is not in the chain.',
    'Check: For every claim, is the cited evidence in the chain? If no citation provided, what is it based on?',
    '',
    '### 3. Anchoring Failure',
    'The verifier IGNORED evidence that IS in the chain.',
    'Example: The chain shows a sanitizer at line 15, but the verifier claimed no sanitization.',
    'Check: Are there protections in the chain that the verifier overlooked? Evidence that contradicts the verdict?',
    '',
    '### 4. Over-Trust',
    'The verifier treated an UNVERIFIED external dependency as safe.',
    'Example: "The ORM sanitizes queries" — but the ORM\'s internals are not in the chain.',
    'Check: Does the verifier assume safety of code not traced in the chain?',
    '',
    '## JUDGMENT CRITERIA',
    '- agree: No material flaws found. Reasoning is sound and anchored to the chain.',
    '- disagree: At least ONE specific, material flaw found. You MUST identify it.',
    '- defer: Cannot determine (chain incomplete, ambiguous). Prefer disagree if uncertain.',
    '',
    '## IMPORTANT',
    '- You need at least ONE specific, concrete flaw to disagree.',
    '  Vague concerns or stylistic critiques are NOT sufficient.',
    '- If you disagree, explain exactly what must be re-examined.',
    '- Be strict. The cost of a false negative (missing a real vuln) > false positive.',
    '',
    '## OUTPUT FORMAT',
    '{',
    '  "judgment": "agree" | "disagree" | "defer",',
    '  "flaws": [',
    '    { "category": "phantom_mitigation",',
    '      "description": "Verifier claims input is sanitized at src/handler.ts:20, but line 20 is NOT in the evidence chain",',
    '      "location": "defenseArgs[0]" }',
    '  ],',
    '  "vetoReason": "The defense relies on a protection not present in the evidence chain. Phase III must be redone without this phantom mitigation."',
    '}',
    '',
    'If judgment is "agree", flaws should be [].',
    'Output inside ```json ... ```',
  ].join('\n');
}

function buildMetaAuditUserPrompt(
  clue: ClueTuple,
  chain: EvidenceChain,
  dr: DialecticResult,
): string {
  const attacks = dr.attackSteps
    .map((s) => `  - ${s.citedFile}:${s.citedLine} → ${s.step}`)
    .join('\n');
  const defenses = dr.defenseArgs
    .map((d) => `  - ${d.citedFile}:${d.citedLine} → ${d.mitigation}`)
    .join('\n');

  return [
    '## CLUE',
    `  Rule: ${clue.rule} (${clue.severity})`,
    `  Location: ${clue.file}:${clue.line}`,
    `  Statement: ${clue.statement}`,
    '',
    '## EVIDENCE CHAIN (closed — all facts are here)',
    formatEvidenceSummary(chain),
    '',
    chain.protectionsMissing.length > 0
      ? `## Protections MISSING\n${chain.protectionsMissing.map((p) => `  - ${p.location}: ${p.expected}`).join('\n')}`
      : '',
    '',
    '## PHASE III RESULT',
    `  Verdict: ${dr.adjudication.verdict} (confidence: ${dr.adjudication.confidence.toFixed(2)})`,
    `  Factual Basis: ${dr.factualBasis.slice(0, 300)}`,
    `  Attack Steps:\n${attacks || '  (none)'}`,
    `  Defense Args:\n${defenses || '  (none)'}`,
    `  Reasoning: ${dr.adjudication.reasoning}`,
    '',
    '## YOUR TASK',
    'Audit the Phase III reasoning above against the evidence chain.',
    'Find phantom mitigations, speculation, anchoring failures, and over-trust.',
    'Output your judgment.',
  ].join('\n');
}

// ---- Parser ----

interface RawMetaAudit {
  judgment: string;
  flaws: Array<{ category: string; description: string; location: string }>;
  vetoReason?: string;
}

const VALID_FLAWS = new Set<FlawCategory>([
  'phantom_mitigation',
  'speculation',
  'anchoring_failure',
  'over_trust',
]);

function parseMetaAudit(content: string | null): MetaAuditResult | null {
  const text = content ?? '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch?.[1]?.trim() ?? text.trim();

  try {
    const objMatch = jsonStr.match(/\{[\s\S]*"judgment"[\s\S]*\}/);
    if (!objMatch) return null;

    const raw: RawMetaAudit = JSON.parse(objMatch[0]);

    const validJudgments = new Set(['agree', 'disagree', 'defer']);
    const judgment = validJudgments.has(raw.judgment) ? raw.judgment : 'defer';

    const flaws: ReasoningFlaw[] = (raw.flaws || [])
      .filter((f) => typeof f.category === 'string' && typeof f.description === 'string')
      .map((f) => ({
        category: VALID_FLAWS.has(f.category as FlawCategory)
          ? (f.category as FlawCategory)
          : ('speculation' as FlawCategory),
        description: f.description,
        location: f.location || 'unknown',
      }));

    return {
      judgment: judgment as MetaAuditResult['judgment'],
      flaws,
      vetoReason: raw.vetoReason,
    };
  } catch (err) {
    debug.error('llm', 'Phase IV: JSON parse error', err);
    return null;
  }
}

// ---- Main ----

export interface MetaAuditVerifyResult {
  result: MetaAuditResult;
  tokenUsage: { total: number };
}

/**
 * Phase IV: Independent meta-audit of Phase III reasoning.
 * Only run on confirmed/warning findings.
 * If disagree, Phase III must be re-done with flaw annotations.
 */
export async function metaAudit(
  llm: IDeepSeekClient,
  clue: ClueTuple,
  chain: EvidenceChain,
  dialecticResult: DialecticResult,
): Promise<MetaAuditVerifyResult> {
  const systemPrompt = buildMetaAuditSystemPrompt();
  const userPrompt = buildMetaAuditUserPrompt(clue, chain, dialecticResult);

  const resp = await llm.chat({
    messages: [
      { role: MESSAGE_ROLE.SYSTEM, content: systemPrompt },
      { role: MESSAGE_ROLE.USER, content: userPrompt },
    ],
    thinking: { type: THINKING_TYPE.DISABLED },
    maxTokens: 2000,
  });

  const totalTokens = resp.usage.promptTokens + resp.usage.completionTokens;

  let result = parseMetaAudit(resp.message.content);
  if (!result) {
    debug.warn('llm', 'Phase IV: parse failed, deferring');
    result = {
      judgment: 'defer',
      flaws: [{ category: 'speculation', description: 'Meta-audit output could not be parsed.', location: 'output' }],
    };
  }

  return { result, tokenUsage: { total: totalTokens } };
}
