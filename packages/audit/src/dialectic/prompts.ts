// ============================================================
// Audit Prompts — DeepSeek KV Cache 优化
//
// ★ system prompt 包含 rule metadata → 同 rule 连续调用命中前缀缓存
//   user prompt 包含 code + evidence → 每 finding 不同，但短
//
// DeepSeek KV Cache 规则:
//   - 自动检测公共前缀并落盘
//   - 请求间完整匹配的前缀 token 序列才会命中
//   - system message 完全相同 → 全量命中
// ============================================================

import type { Finding } from "../finding.js";

// ---- Split prompts (KV Cache optimized) ----

/**
 * System prompt — contains rule metadata only.
 *
 * ★ 同一 rule 的多个 finding 共享完全相同的 system prompt
 *   → DeepSeek KV Cache 自动命中，省 ~80 tokens/finding
 */
export function buildSystemPrompt(finding: Finding): string {
  return [
    'You are a code security auditor. Output ONLY valid JSON. No markdown.',
    `<rule>${finding.rule} — ${finding.severity}</rule>`,
    `<description>${finding.description}</description>`,
  ].join('\n');
}

/**
 * User prompt — finding-specific code + evidence.
 *
 * ★ 每个 finding 不同，但格式稳定（同样的 XML 标签顺序）
 *   → DeepSeek 可能识别结构相似性
 */
export function buildUserPrompt(
  finding: Finding,
  code: string,
  evidence: EvidenceLabels,
): string {
  const parts: string[] = [];

  parts.push(`<title>${finding.title}</title>`);
  parts.push(`<file>${finding.file}:${finding.line}</file>`);
  parts.push(`<code>\n${code}\n</code>`);

  const ev: string[] = [];
  if (evidence.sources.length > 0) {
    ev.push(`  sources: ${evidence.sources.slice(0, 3).join(' | ')}`);
  }
  if (evidence.sinks.length > 0) {
    ev.push(`  sinks: ${evidence.sinks.slice(0, 3).join(' | ')}`);
  }
  if (evidence.protections.length > 0) {
    ev.push(`  protections: ${evidence.protections.slice(0, 3).join(' | ')}`);
  }
  if (evidence.crossRefs.length > 0) {
    ev.push(`  cross_ref:\n${evidence.crossRefs.map(c => `    - ${c}`).join('\n')}`);
  }
  if (ev.length > 0) {
    parts.push(`<evidence>\n${ev.join('\n')}\n</evidence>`);
  }

  parts.push('');
  parts.push('Is this finding a real vulnerability? Output your verdict as JSON:');
  parts.push('{ "verdict": "confirmed" | "warning" | "dismissed", "confidence": 0.0, "decisiveEvidence": ["..."], "reasoning": "..." }');

  return parts.join('\n');
}

/** Structured evidence labels — trigram-detected, no narrative */
export interface EvidenceLabels {
  sources: string[];
  sinks: string[];
  protections: string[];
  crossRefs: string[];
}

// ============================================================
// Legacy — deprecated wrappers
// ============================================================

import type { CodeContext } from "../finding.js";

/** @deprecated Use buildSystemPrompt + buildUserPrompt instead */
export function buildAuditPrompt(finding: Finding, code: string, evidence: EvidenceLabels): string {
  return `${buildSystemPrompt(finding)}\n\n${buildUserPrompt(finding, code, evidence)}`;
}

/** @deprecated */
export function buildAttackPrompt(finding: Finding, ctx: CodeContext): string {
  return buildAuditPrompt(finding, ctx.surroundingCode, { sources: [], sinks: [], protections: [], crossRefs: [] });
}

/** @deprecated */
export function buildDefensePrompt(finding: Finding, ctx: CodeContext, _a: unknown[]): string {
  return buildAuditPrompt(finding, ctx.surroundingCode, { sources: [], sinks: [], protections: [], crossRefs: [] });
}

/** @deprecated */
export function buildAdjudicatorPrompt(finding: Finding, _f: string, _a: unknown[], _d: unknown[]): string {
  return buildAuditPrompt(finding, '', { sources: [], sinks: [], protections: [], crossRefs: [] });
}

/** @deprecated */
export interface DialecticPromptSet { attackPrompt: string; defensePrompt: string; adjudicatorPrompt: string; }

/** @deprecated */
export function buildFullPromptSet(f: Finding, c: CodeContext, _fb: string, _a: unknown[], _d: unknown[]): DialecticPromptSet {
  const p = buildAuditPrompt(f, c.surroundingCode, { sources: [], sinks: [], protections: [], crossRefs: [] });
  return { attackPrompt: p, defensePrompt: p, adjudicatorPrompt: p };
}
