// ============================================================
// Phase I — Clue Discovery (AEGIS: Worst-Case Taint Assumption)
//
// ★ 高召回。每条规则搜全项目，不确定也记下来。
//   把每一个可信的异常都当作值得调查的线索。
// ============================================================

import { MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import type { ToolCall } from '@comdr/core/types';
import { AUDIT_TOOLS } from '../tools/executor.js';
import type { IToolExecutor } from '../tools/executor.js';
import type { RuleDefinition } from './prompts.js';
import type { ClueTuple } from './types.js';
import { debug } from '../debug.js';

// ---- Prompt ----

function buildDiscoverSystemPrompt(rules: RuleDefinition[]): string {
  const rulesBlock = rules
    .map(
      (r) =>
        `  <rule id="${r.id}" severity="${r.severity}" category="${r.category}">` +
        `\n    <description>${r.description}</description>` +
        `\n  </rule>`,
    )
    .join('\n');

  return [
    '## ROLE',
    'You are a CLUE DISCOVERY agent in a code security audit pipeline.',
    'Your job: find EVERY suspicious location in the codebase. HIGH RECALL.',
    '',
    '## PRINCIPLE: Worst-Case Taint Assumption',
    'Assume every non-local data source (HTTP params, file reads, env vars,',
    'database results, message queues, localStorage) is UNTRUSTED.',
    'If in doubt, flag it. False positives are OK — missed vulnerabilities are NOT.',
    '',
    '## WORKFLOW',
    '1. Use file_glob to discover project files.',
    '2. For each rule below, use file_grep to search for suspicious patterns.',
    '3. When you find a candidate, use file_read to confirm it is worth flagging.',
    '4. Do not adjudicate — just collect clues. Verdict comes later.',
    '',
    '## RULES TO SCAN',
    `<rules>\n${rulesBlock}\n</rules>`,
    '',
    '## OUTPUT FORMAT',
    'Output a JSON array of clue tuples. Each clue must have:',
    '{',
    '  "file": "relative/path.ts",',
    '  "line": 42,',
    '  "statement": "db.query(\'SELECT ...\' + userId)",',
    '  "rule": "security/sql-injection",',
    '  "severity": "critical",',
    '  "category": "security",',
    '  "confidence": 0.85,',
    '  "whySuspicious": "User input userId concatenated into SQL query without parameterization"',
    '}',
    '',
    'Confidence guide:',
    '  0.9+ = obvious vulnerability (eval with user input, hardcoded password)',
    '  0.7–0.9 = suspicious but needs deeper analysis',
    '  0.5–0.7 = potential issue, flag for investigation',
    '',
    'Output the JSON array inside a markdown code fence: ```json ... ```',
  ].join('\n');
}

function buildDiscoverUserPrompt(projectRoot: string, files?: string[]): string {
  const scope =
    files && files.length > 0
      ? `\nScope: ONLY audit these files:\n${files.map((f) => `  - ${f}`).join('\n')}\n`
      : '';

  return [
    `Project root: ${projectRoot}${scope}`,
    '',
    files && files.length > 0
      ? 'Audit ONLY the files listed above. Do not search outside this scope.'
      : 'Begin clue discovery. Start with file_glob to see the project structure.',
    'Systematically search for each rule pattern with file_grep.',
    'Flag everything suspicious. When done, output your complete clue list.',
  ].join('\n');
}

// ---- Parser ----

interface RawClue {
  file: string;
  line: number;
  statement: string;
  rule: string;
  severity: string;
  category: string;
  confidence: number;
  whySuspicious: string;
}

function parseClues(content: string | null, rules: RuleDefinition[]): ClueTuple[] {
  const text = content ?? '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch?.[1]?.trim() ?? text.trim();

  // Find outermost JSON array
  const arrayMatch = jsonStr.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!arrayMatch) {
    debug.warn('llm', 'Phase I: no JSON array found in response');
    return [];
  }

  try {
    const raw: RawClue[] = JSON.parse(arrayMatch[0]);
    const validRuleIds = new Set(rules.map((r) => r.id));

    return raw
      .filter(
        (c): c is RawClue =>
          typeof c.file === 'string' &&
          typeof c.line === 'number' &&
          typeof c.statement === 'string' &&
          typeof c.rule === 'string',
      )
      .map((c, i) => ({
        id: `clue-${i}-${Date.now().toString(36)}`,
        file: c.file,
        line: c.line,
        statement: c.statement,
        rule: validRuleIds.has(c.rule) ? c.rule : 'unknown',
        severity: (['critical', 'high', 'medium', 'low', 'info'].includes(c.severity)
          ? c.severity
          : 'medium') as ClueTuple['severity'],
        category: (['security', 'quality', 'perf', 'convention', 'bug'].includes(c.category)
          ? c.category
          : 'security') as ClueTuple['category'],
        confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.7,
        whySuspicious: c.whySuspicious || 'No explanation provided.',
      }));
  } catch (err) {
    debug.error('llm', 'Phase I: JSON parse error', err);
    return [];
  }
}

// ---- Main ----

export interface DiscoverResult {
  clues: ClueTuple[];
  tokenUsage: { total: number };
}

/**
 * Phase I: Discover suspicious clues across the project.
 * One LLM call with tool-calling loop, covering all rules.
 */
export async function discoverClues(
  llm: IDeepSeekClient,
  tools: IToolExecutor,
  rules: RuleDefinition[],
  projectRoot: string,
  maxTurns: number,
  files?: string[],
): Promise<DiscoverResult> {
  const systemPrompt = buildDiscoverSystemPrompt(rules);
  const userPrompt = buildDiscoverUserPrompt(projectRoot, files);

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

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await llm.chat({
      messages: messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
      tools: AUDIT_TOOLS,
      thinking: { type: THINKING_TYPE.DISABLED },
      maxTokens: 4000,
    });

    totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;

    // No tool calls → LLM is returning the clue list
    if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
      const clues = parseClues(resp.message.content, rules);
      debug.info('llm', `Phase I: discovered ${clues.length} clues in ${turn + 1} turns`);
      return { clues, tokenUsage: { total: totalTokens } };
    }

    // Execute tool calls
    messages.push({
      role: MESSAGE_ROLE.ASSISTANT,
      content: resp.message.content,
      tool_calls: resp.message.tool_calls,
      reasoning_content: resp.message.reasoning_content,
    });

    for (const tc of resp.message.tool_calls) {
      try {
        const result = await tools.execute(tc);
        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: tc.id,
        });
      } catch (err) {
        messages.push({
          role: 'tool',
          content: `Tool error: ${String(err).slice(0, 200)}`,
          tool_call_id: tc.id,
        });
      }
    }
  }

  // Max turns reached — force output
  messages.push({
    role: MESSAGE_ROLE.USER,
    content:
      'Max tool calls reached. Output your complete clue list as a JSON array NOW. Include all suspicious locations you found.',
  });

  const resp = await llm.chat({
    messages: messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
    })),
    thinking: { type: THINKING_TYPE.DISABLED },
    maxTokens: 4000,
  });

  totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;
  const clues = parseClues(resp.message.content, rules);
  debug.info('llm', `Phase I (forced): discovered ${clues.length} clues`);

  return { clues, tokenUsage: { total: totalTokens } };
}
