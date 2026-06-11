// ============================================================
// Phase II — Evidence Chain Construction (AEGIS: Closed Evidence Set)
//
// ★ 逐条线索追踪数据流。向后溯源 → 向前追踪 → 列出保护缺失。
//   关键约束: 链上找不到的防护 = 不存在。
// ============================================================

import { MESSAGE_ROLE, THINKING_TYPE } from '@comdr/core';
import type { IDeepSeekClient } from '@comdr/core/contracts';
import type { ToolCall } from '@comdr/core/types';
import { AUDIT_TOOLS } from '../tools/executor.js';
import type { IToolExecutor } from '../tools/executor.js';
import type { ClueTuple, EvidenceChain, EvidenceNode } from './types.js';
import { debug } from '../debug.js';

// ---- Prompt ----

function buildEvidenceSystemPrompt(): string {
  return [
    '## ROLE',
    'You are an EVIDENCE CHAIN CONSTRUCTOR in a code security audit pipeline.',
    'Your job: trace the COMPLETE data flow around a suspicious code location.',
    '',
    '## PRINCIPLE: Closed Evidence Set',
    'You MUST cite only code you have actually read with file_read.',
    'If a protection (sanitizer, validator, parameterized query, escape,',
    'bounds check, auth guard, CSP header) does NOT appear in the code you read,',
    'it DOES NOT EXIST. Record its absence explicitly.',
    '',
    '## WORKFLOW',
    '1. Read the file containing the suspicious line.',
    '2. Trace BACKWARD: where does the suspicious variable come from?',
    '   Follow through assignments, function returns, parameters.',
    '   Cross file boundaries when needed (read the caller/upstream file).',
    '3. Trace FORWARD: where does the suspicious variable flow to?',
    '   What downstream operations consume it?',
    '4. At each step, check for protections:',
    '   - Input validation (typeof, regex, allowlist, schema)',
    '   - Sanitization (escape, encode, strip, DOMPurify)',
    '   - Parameterization (prepared statements, ? placeholders, ORM)',
    '   - Authorization (auth check, role check, ownership check)',
    '   - Output encoding (htmlspecialchars, encodeURI, textContent)',
    '5. Record any cross-file call boundaries with the call site location.',
    '',
    '## OUTPUT FORMAT',
    'Output a single JSON object:',
    '{',
    '  "backwardChain": [',
    '    { "file": "src/handler.ts", "line": 10, "code": "const id = req.params.id",',
    '      "role": "source", "description": "Untrusted user input from URL parameter" }',
    '  ],',
    '  "forwardChain": [',
    '    { "file": "src/db.ts", "line": 42, "code": "db.query(sql)",',
    '      "role": "sink", "description": "SQL query executed with constructed string" }',
    '  ],',
    '  "protectionsFound": [',
    '    { "file": "src/handler.ts", "line": 12, "code": "if (typeof id !== \'string\') return",',
    '      "role": "protection", "description": "Type check, but does not prevent SQL injection" }',
    '  ],',
    '  "protectionsMissing": [',
    '    { "location": "src/db.ts:42",',
    '      "expected": "Parameterized query or input escaping before SQL execution" }',
    '  ],',
    '  "crossFileBoundaries": [',
    '    { "from": "src/handler.ts", "to": "src/db.ts", "callSite": "db.query(sql)" }',
    '  ],',
    '  "isComplete": true',
    '}',
    '',
    'Roles for evidence nodes: "source" | "transform" | "sink" | "protection" | "branch"',
    '',
    'IMPORTANT: protectionsMissing is NOT optional. For every sink in the forward chain,',
    'ask yourself: "What protection SHOULD be here?" If none, record it as missing.',
    '',
    'Output the JSON inside a markdown code fence: ```json ... ```',
  ].join('\n');
}

function buildEvidenceUserPrompt(clue: ClueTuple): string {
  return [
    `<clue id="${clue.id}">`,
    `  <file>${clue.file}:${clue.line}</file>`,
    `  <statement>${clue.statement}</statement>`,
    `  <rule>${clue.rule} — ${clue.severity}</rule>`,
    `  <whySuspicious>${clue.whySuspicious}</whySuspicious>`,
    `</clue>`,
    '',
    'Start by reading the file containing this clue.',
    'Trace the FULL data flow: backward to sources, forward to sinks.',
    'Document every protection found and every protection missing.',
  ].join('\n');
}

// ---- Parser ----

interface RawEvidenceChain {
  backwardChain: RawNode[];
  forwardChain: RawNode[];
  protectionsFound: RawNode[];
  protectionsMissing: Array<{ location: string; expected: string }>;
  crossFileBoundaries: Array<{ from: string; to: string; callSite: string }>;
  isComplete: boolean;
}

interface RawNode {
  file: string;
  line: number;
  code: string;
  role: string;
  description: string;
}

const VALID_ROLES = new Set(['source', 'transform', 'sink', 'protection', 'branch']);

function parseEvidenceChain(content: string | null, clueId: string): EvidenceChain | null {
  const text = content ?? '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch?.[1]?.trim() ?? text.trim();

  try {
    // Find outermost JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!objMatch) return null;

    const raw: RawEvidenceChain = JSON.parse(objMatch[0]);

    const normalizeNodes = (nodes: RawNode[]): EvidenceNode[] =>
      (nodes || [])
        .filter((n) => typeof n.file === 'string' && typeof n.line === 'number')
        .map((n) => ({
          file: n.file,
          line: n.line,
          code: n.code || '',
          role: VALID_ROLES.has(n.role) ? (n.role as EvidenceNode['role']) : 'transform',
          description: n.description || '',
        }));

    return {
      clueId,
      backwardChain: normalizeNodes(raw.backwardChain || []),
      forwardChain: normalizeNodes(raw.forwardChain || []),
      protectionsFound: normalizeNodes(raw.protectionsFound || []),
      protectionsMissing: (raw.protectionsMissing || [])
        .filter((p) => typeof p.location === 'string' && typeof p.expected === 'string'),
      crossFileBoundaries: (raw.crossFileBoundaries || [])
        .filter((b) => typeof b.from === 'string' && typeof b.to === 'string'),
      isComplete: raw.isComplete === true,
    };
  } catch (err) {
    debug.error('llm', 'Phase II: JSON parse error', err);
    return null;
  }
}

// ---- Main ----

export interface EvidenceResult {
  chain: EvidenceChain | null;
  tokenUsage: { total: number };
}

/**
 * Phase II: Build evidence chain for a single clue.
 * Each clue is independent — run in parallel for multiple clues.
 */
export async function buildEvidenceChain(
  llm: IDeepSeekClient,
  tools: IToolExecutor,
  clue: ClueTuple,
  maxTurns = 5,
): Promise<EvidenceResult> {
  const systemPrompt = buildEvidenceSystemPrompt();
  const userPrompt = buildEvidenceUserPrompt(clue);

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
      maxTokens: 3000,
    });

    totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;

    if (!resp.message.tool_calls || resp.message.tool_calls.length === 0) {
      const chain = parseEvidenceChain(resp.message.content, clue.id);
      if (chain) {
        return { chain, tokenUsage: { total: totalTokens } };
      }
      // Parse failed — push a retry message
      messages.push({
        role: MESSAGE_ROLE.USER,
        content:
          'Your output was not valid JSON. Please output the evidence chain as a valid JSON object inside ```json ... ``` fences.',
      });
      continue;
    }

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

  // Max turns — force output
  messages.push({
    role: MESSAGE_ROLE.USER,
    content:
      'Max tool calls reached. Output your evidence chain as a JSON object NOW. Mark isComplete: false if you could not fully trace the flow.',
  });

  const resp = await llm.chat({
    messages: messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
    })),
    thinking: { type: THINKING_TYPE.DISABLED },
    maxTokens: 2000,
  });

  totalTokens += resp.usage.promptTokens + resp.usage.completionTokens;
  const chain = parseEvidenceChain(resp.message.content, clue.id);
  if (chain) {
    chain.isComplete = false; // forced output = incomplete
  }

  return { chain, tokenUsage: { total: totalTokens } };
}
