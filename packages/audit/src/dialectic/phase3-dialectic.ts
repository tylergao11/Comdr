// ============================================================
// Phase III — Dialectical Verification (AEGIS: Single-Agent Dialectic)
//
// ★ Red Team 攻击 → Blue Team 防御 → 证据加权裁决。
//   单 Agent 三步内化。每 claim 必须 cite 证据链行号。
//   不调工具——证据链已是封闭事实集。
// ============================================================

import { MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import type { ClueTuple, EvidenceChain, DialecticResult } from './types.js';
import type { Adjudication } from '../finding.js';
import { debug } from '../debug.js';

// ---- Prompt ----

function formatChain(chain: EvidenceChain): string {
  const formatNodes = (title: string, nodes: EvidenceChain['backwardChain']) =>
    nodes.length === 0
      ? `  ${title}: (none)`
      : [
          `  ${title}:`,
          ...nodes.map(
            (n) =>
              `    ${n.file}:${n.line} [${n.role}] ${n.code.slice(0, 150)}` +
              `\n      → ${n.description}`,
          ),
        ].join('\n');

  const missing = chain.protectionsMissing
    .map((p) => `  - ${p.location}: ${p.expected}`)
    .join('\n');

  return [
    `## Evidence Chain for Clue: ${chain.clueId}`,
    '',
    formatNodes('Backward (source → clue)', chain.backwardChain),
    '',
    formatNodes('Forward (clue → sink)', chain.forwardChain),
    '',
    formatNodes('Protections Found', chain.protectionsFound),
    '',
    '## Protections MISSING (CRITICAL — these are what make it vulnerable)',
    missing || '  (none — all expected protections are present)',
    '',
    `Chain complete: ${chain.isComplete ? 'yes' : 'no (truncated)'}`,
    chain.crossFileBoundaries.length > 0
      ? `\nCross-file boundaries:\n${chain.crossFileBoundaries.map((b) => `  ${b.from} → ${b.to} (${b.callSite})`).join('\n')}`
      : '',
  ].join('\n');
}

function buildDialecticSystemPrompt(): string {
  return [
    '## ROLE',
    'You are a DIALECTICAL VERIFIER in a code security audit pipeline.',
    'You will receive an evidence chain (pre-built, no further tools available).',
    'You must execute THREE roles in sequence, then adjudicate.',
    '',
    '## CRITICAL RULE: Evidence Chain Boundary',
    'You MAY ONLY cite code that appears in the evidence chain below.',
    'If a protection does not appear in the chain, IT DOES NOT EXIST.',
    'If a code path is not in the chain, YOU CANNOT SPECULATE ABOUT IT.',
    'Every claim MUST reference a specific file:line from the evidence chain.',
    '',
    '## STEP 1: Factual Comprehension',
    '- What does the suspicious code do, factually?',
    '- Where does each variable originate (trace through backward chain)?',
    '- What sinks does data flow to (trace through forward chain)?',
    '- What protections exist? What is explicitly MISSING?',
    '- State the EXACT mitigation that would make this code safe.',
    '',
    '## STEP 2: Red Team — Construct the Attack',
    'Adopt the attacker perspective. Build a concrete exploit chain:',
    '- How can an attacker control the data source?',
    '- How does untrusted data propagate through each transform node?',
    '- How does it reach the sink without being stopped?',
    '- What is the impact (data leak, RCE, XSS, auth bypass)?',
    'Cite specific file:line from the evidence chain for each step.',
    'Be aggressive. If there is a plausible attack path, argue for it.',
    '',
    '## STEP 3: Blue Team — Construct the Defense',
    'Switch perspectives. Argue for safety:',
    '- Are the data sources actually attacker-controllable? (check context)',
    '- Do existing protections (even weak ones) block the attack?',
    '- Is the sink in a context that limits exploitability?',
    '- Are there implicit guards (type system, framework defaults)?',
    'Cite specific file:line from the evidence chain for each argument.',
    'Be honest. If there are real defenses, acknowledge them.',
    '',
    '## STEP 4: Adjudication',
    'Drop both personas. Weigh the arguments under ONE principle:',
    '"Concrete evidence from the chain outweighs speculation."',
    '',
    'Verdict guide:',
    '- confirmed: Clear exploit path, no effective protection in chain',
    '- warning: Suspicious but mitigating factors exist, or chain incomplete',
    '- dismissed: Attack path blocked by concrete protections in chain, or source not attacker-controllable',
    '',
    '## OUTPUT FORMAT',
    'Output a single JSON object:',
    '{',
    '  "factualBasis": "Neutral summary of what the code does...",',
    '  "attackSteps": [',
    '    { "step": "Attacker sends crafted payload via HTTP POST body parameter \'name\'",',
    '      "citedFile": "src/handler.ts", "citedLine": 10 },',
    '    { "step": "Unsanitized \'name\' flows through concatenation into SQL string",',
    '      "citedFile": "src/db.ts", "citedLine": 42 }',
    '  ],',
    '  "defenseArgs": [',
    '    { "mitigation": "Type check on line 12 ensures \'name\' is a string, but does not prevent SQL injection",',
    '      "citedFile": "src/handler.ts", "citedLine": 12 }',
    '  ],',
    '  "adjudication": {',
    '    "verdict": "confirmed",',
    '    "confidence": 0.92,',
    '    "decisiveEvidence": ["src/handler.ts:10 — req.params.id is untrusted user input", "src/db.ts:42 — No parameterization, direct concatenation into SQL"],',
    '    "reasoning": "Clear attack path from untrusted input to SQL sink without parameterization. Type check at line 12 does not mitigate injection risk."',
    '  }',
    '}',
    '',
    'Output inside ```json ... ```',
  ].join('\n');
}

function buildDialecticUserPrompt(clue: ClueTuple, chain: EvidenceChain): string {
  return [
    `<clue>`,
    `  <id>${clue.id}</id>`,
    `  <file>${clue.file}:${clue.line}</file>`,
    `  <statement>${clue.statement}</statement>`,
    `  <rule>${clue.rule} — ${clue.severity}</rule>`,
    `  <whySuspicious>${clue.whySuspicious}</whySuspicious>`,
    `</clue>`,
    '',
    formatChain(chain),
    '',
    'Execute all four steps (Factual → Attack → Defense → Adjudicate) and output your verdict.',
  ].join('\n');
}

// ---- Parser ----

interface RawDialecticResult {
  factualBasis: string;
  attackSteps: Array<{ step: string; citedFile: string; citedLine: number }>;
  defenseArgs: Array<{ mitigation: string; citedFile: string; citedLine: number }>;
  adjudication: {
    verdict: string;
    confidence: number;
    decisiveEvidence: string[];
    reasoning: string;
  };
}

function parseDialecticResult(content: string | null): DialecticResult | null {
  const text = content ?? '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch?.[1]?.trim() ?? text.trim();

  try {
    const objMatch = jsonStr.match(/\{[\s\S]*"adjudication"[\s\S]*\}/);
    if (!objMatch) return null;

    const raw: RawDialecticResult = JSON.parse(objMatch[0]);

    const validVerdicts = new Set(['confirmed', 'warning', 'dismissed']);
    const v = raw.adjudication?.verdict;
    const verdict = validVerdicts.has(v) ? v : 'warning';

    return {
      factualBasis: raw.factualBasis || 'No factual basis provided.',
      attackSteps: (raw.attackSteps || [])
        .filter((s) => typeof s.step === 'string' && typeof s.citedFile === 'string')
        .map((s) => ({
          step: s.step,
          citedFile: s.citedFile,
          citedLine: typeof s.citedLine === 'number' ? s.citedLine : 0,
        })),
      defenseArgs: (raw.defenseArgs || [])
        .filter((d) => typeof d.mitigation === 'string' && typeof d.citedFile === 'string')
        .map((d) => ({
          mitigation: d.mitigation,
          citedFile: d.citedFile,
          citedLine: typeof d.citedLine === 'number' ? d.citedLine : 0,
        })),
      adjudication: {
        verdict: verdict as Adjudication['verdict'],
        confidence:
          typeof raw.adjudication?.confidence === 'number'
            ? Math.max(0, Math.min(1, raw.adjudication.confidence))
            : 0.5,
        decisiveEvidence: Array.isArray(raw.adjudication?.decisiveEvidence)
          ? raw.adjudication.decisiveEvidence
          : [],
        reasoning: raw.adjudication?.reasoning || 'No reasoning provided.',
      },
    };
  } catch (err) {
    debug.error('llm', 'Phase III: JSON parse error', err);
    return null;
  }
}

// ---- Main ----

export interface DialecticVerifyResult {
  result: DialecticResult;
  tokenUsage: { total: number };
}

/**
 * Phase III: Dialectical verification on a closed evidence chain.
 * No tool calls — the evidence chain IS the complete factual substrate.
 */
export async function dialecticVerify(
  llm: IDeepSeekClient,
  clue: ClueTuple,
  chain: EvidenceChain,
): Promise<DialecticVerifyResult> {
  const systemPrompt = buildDialecticSystemPrompt();
  const userPrompt = buildDialecticUserPrompt(clue, chain);

  // Single LLM call — no tools, no loop. Evidence chain is closed.
  const resp = await llm.chat({
    messages: [
      { role: MESSAGE_ROLE.SYSTEM, content: systemPrompt },
      { role: MESSAGE_ROLE.USER, content: userPrompt },
    ],
    thinking: { type: THINKING_TYPE.DISABLED },
    maxTokens: 3000,
  });

  const totalTokens = resp.usage.promptTokens + resp.usage.completionTokens;

  let result = parseDialecticResult(resp.message.content);
  if (!result) {
    // Fallback: construct a minimal result
    debug.warn('llm', 'Phase III: parse failed, using fallback verdict');
    result = {
      factualBasis: 'Parse failed — raw response: ' + (resp.message.content ?? '').slice(0, 200),
      attackSteps: [],
      defenseArgs: [],
      adjudication: {
        verdict: 'warning' as Adjudication['verdict'],
        confidence: 0.5,
        decisiveEvidence: ['Phase III output could not be parsed.'],
        reasoning:
          'Dialectic verification output was malformed. Marked as warning for manual review.',
      },
    };
  }

  return { result, tokenUsage: { total: totalTokens } };
}
