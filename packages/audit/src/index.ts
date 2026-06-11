// ============================================================
// @comdr/audit — Agent 5: Code Audit Engine
//
// ★ Trigram-powered semantic code audit.
//   零正则——规则匹配、证据提取、裁决全部走 trigram 向量余弦相似度。
//
// Self-contained engine. @comdr integration adapters
// will be added when @comdr/core, @comdr/llm, @comdr/tools are built.
// ============================================================

// Types
export type {
  Finding, Severity, Category, FindingSource, Verdict,
  SymbolRef, CodeContext, DialecticInput,
  FactualBasis, AttackArg, DefenseArg, Adjudication, DialecticSession,
} from "./finding.js";
export { severityMeets, generateFindingId } from "./finding.js";

// Scanner
export { TrigramSemanticScanner } from "./scanner/scanner.js";
export { formatScanReport } from "./scanner/reporter.js";
export type { ScannerConfig, ScanResult, ScanStats, CodeChunk } from "./scanner/scanner.js";

// Code Chunker
export { CodeChunker, createChunker } from "./code-chunker.js";
export type { ChunkerConfig } from "./code-chunker.js";

// Rules
export { getAllRules, getRulesForLanguage, detectLanguage, matchChunk, scanChunks } from "./rules/index.js";
export { SECURITY_RULES } from "./rules/security.js";
export { QUALITY_RULES } from "./rules/quality.js";
export type { HeuristicRule, HeuristicLanguage, RuleMatch } from "./rules/types.js";

// Dialectic
export { DialecticVerifier } from "./dialectic/verifier.js";
export { heuristicAdjudicate } from "./dialectic/adjudicator.js";
export {
  buildAuditPrompt,
  // legacy — deprecated
  buildAttackPrompt, buildDefensePrompt,
  buildAdjudicatorPrompt, buildFullPromptSet,
} from "./dialectic/prompts.js";
export type { EvidenceLabels } from "./dialectic/prompts.js";
export type { VerifierResult, DialecticVerifierConfig } from "./dialectic/verifier.js";
// legacy type — deprecated
export type { DialecticPromptSet } from "./dialectic/prompts.js";

// Trigram Evidence (shared by verifier + adjudicator)
export {
  detectByTrigram,
  hasPattern,
  SOURCE_DESCRIPTORS,
  SINK_DESCRIPTORS,
  PROTECTION_DESCRIPTORS,
} from "./dialectic/evidence.js";

// Pipeline
export { AuditPipeline } from "./pipeline.js";

// ---- MCP Tool Definitions (for Agent 4 integration) ----

import type { Finding } from "./finding.js";
import { TrigramSemanticScanner } from "./scanner/scanner.js";
import { formatScanReport } from "./scanner/reporter.js";
import { DialecticVerifier } from "./dialectic/verifier.js";
import { extractCodeContext } from "./code-context.js";
import { getAllRules } from "./rules/index.js";

/** MCP Tool: comdr.scan — trigram semantic security + quality scan */
export async function toolScan(args: { path: string }): Promise<string> {
  const scanner = new TrigramSemanticScanner();
  const result = scanner.scanDirectory(args.path);
  const report = formatScanReport(result);
  return JSON.stringify({
    findings: result.findings.map(f => ({
      severity: f.severity, category: f.category, title: f.title,
      file: f.file, line: f.line, rule: f.rule, suggestion: f.suggestion,
    })),
    stats: result.stats,
    report,
  }, null, 2);
}

/** MCP Tool: comdr.verify — trigram dialectic verification on a finding */
export async function toolVerify(args: {
  title: string; severity: string; file: string; line: number; snippet: string;
}): Promise<string> {
  const finding: Finding = {
    id: `manual-${Date.now().toString(36)}`,
    severity: (args.severity as Finding["severity"]) || "medium",
    category: "security",
    title: args.title,
    description: "",
    file: args.file,
    line: args.line,
    snippet: args.snippet,
    rule: "manual",
    confidence: 0.5,
    source: "static",
  };

  const verifier = new DialecticVerifier();
  const ctx = extractCodeContext(finding);
  const result = await verifier.verify({ finding, codeContext: ctx }, "heuristic");

  return JSON.stringify({
    verdict: result.session.adjudication.verdict,
    confidence: result.session.adjudication.confidence,
    decisiveEvidence: result.session.adjudication.decisiveEvidence,
    reasoning: result.session.adjudication.reasoning,
  }, null, 2);
}

/** MCP Tool: comdr.rules — list all registered audit rules */
export function toolRules(): string {
  const rules = getAllRules();
  return JSON.stringify({
    rules: rules.map(r => ({
      id: r.id, name: r.name, category: r.category,
      severity: r.severity, cwe: r.cwe, languages: r.languages,
    })),
  }, null, 2);
}
