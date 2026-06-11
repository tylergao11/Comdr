// ============================================================
// Heuristic Adjudicator — Pure trigram pattern matching
//
// ★ 0 token，纯 trigram descriptor 余弦相似度匹配。
//   不做 Attack vs Defense 评分——LLM 自己判定。
//   这里只提供快速确定性裁决作为 LLM 不可用时的 fallback。
// ============================================================

import type { Adjudication, Finding, Verdict } from "../finding.js";
import {
  hasPattern,
  CODE_EXEC_SINKS,
  DOM_INJECTION_SINKS,
  SHELL_EXEC_SINKS,
  SQL_SINKS,
  STRONG_PROTECTIONS,
  MODERATE_PROTECTIONS,
  PROTECTION_DESCRIPTORS,
  SOURCE_DESCRIPTORS,
} from "./evidence.js";

/**
 * Lightweight trigram-based adjudication (0 token, always available).
 *
 * ★ 编排层不教 LLM 怎么想——这里只做确定性 trigram 匹配。
 *   "这段代码跟 XSS descriptor 的 trigram 向量余弦相似度 > 0.3 吗？"
 *   是 → confirmed。否 → warning（留给 LLM 做精确判定）。
 */
export function heuristicAdjudicate(
  finding: Finding,
  code: string,
): Adjudication {
  const haystack = code.toLowerCase();

  // Protection signals
  const hasStrongProtection = hasPattern(haystack, STRONG_PROTECTIONS, 0.32);
  const hasModerateProtection = hasPattern(haystack, MODERATE_PROTECTIONS, 0.30);
  const hasAnyProtection = hasPattern(haystack, PROTECTION_DESCRIPTORS, 0.28);

  // User input
  const hasUserInput = hasPattern(haystack, SOURCE_DESCRIPTORS, 0.32);

  // Danger sinks
  const hasCodeExec = hasPattern(haystack, CODE_EXEC_SINKS, 0.28);
  const hasDOMInjection = hasPattern(haystack, DOM_INJECTION_SINKS, 0.28);
  const hasShellExec = hasPattern(haystack, SHELL_EXEC_SINKS, 0.28);
  const hasSQLSink = hasPattern(haystack, SQL_SINKS, 0.28);
  const hasDangerousSink = hasCodeExec || hasDOMInjection || hasShellExec || hasSQLSink;

  const isSecurity = finding.category === "security";

  // Strong protection → likely false positive
  if (isSecurity && hasStrongProtection && hasAnyProtection && finding.confidence < 0.7) {
    return {
      verdict: "dismissed",
      confidence: 0.75,
      decisiveEvidence: ["Strong protection patterns detected (sanitization + validation) via trigram matching."],
      reasoning: "Trigram: sanitization + validation detected. Likely false positive.",
    };
  }

  // SQL sink with protection → warning
  if (hasSQLSink && hasAnyProtection) {
    return {
      verdict: "warning",
      confidence: 0.60,
      decisiveEvidence: ["SQL-like code detected but protection mechanisms found nearby."],
      reasoning: "Trigram: database operation with protections. Medium confidence.",
    };
  }

  // Clear dangerous sink, no protection → confirm
  if (hasDangerousSink && !hasStrongProtection && !hasModerateProtection) {
    const dangers: string[] = [];
    if (hasCodeExec) dangers.push("code execution");
    if (hasDOMInjection) dangers.push("DOM injection");
    if (hasShellExec) dangers.push("shell execution");
    if (hasSQLSink) dangers.push("SQL sink");
    const extra = hasUserInput ? " User-controllable input detected." : "";
    return {
      verdict: "confirmed",
      confidence: hasUserInput ? 0.80 : 0.65,
      decisiveEvidence: [`Dangerous sink (${dangers.join(" + ")}) with no visible protection.${extra}`],
      reasoning: `Trigram: dangerous sink found, no protection.${extra}`,
    };
  }

  // Mixed signals → defer to LLM
  if (hasDangerousSink && (hasModerateProtection || hasAnyProtection)) {
    return {
      verdict: "warning",
      confidence: 0.55,
      decisiveEvidence: ["Mixed signals — dangerous sink + partial protection."],
      reasoning: "Trigram: mixed signals. Human review or LLM recommended.",
    };
  }

  // Insufficient signal
  return {
    verdict: "warning",
    confidence: 0.50,
    decisiveEvidence: ["Insufficient trigram signal."],
    reasoning: "Trigram: cannot reach strong conclusion. LLM analysis recommended.",
  };
}
