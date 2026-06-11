// ============================================================
// Audit Rule Type Definitions — Trigram Semantic Matching
//
// ★ 正则已废弃。规则匹配全部走 trigram 语义相似度。
//   每条规则用自然语言 descriptors 描述可疑模式，
//   trigram 向量与代码 chunk 做 cosine similarity > threshold → 触发。
// ============================================================

import type { Category, Severity } from "../finding.js";

/** Supported languages for semantic scanning */
export type HeuristicLanguage = "ts" | "js" | "tsx" | "jsx" | "py" | "go";

/**
 * A semantic audit rule definition.
 * Each rule detects a specific vulnerability or code quality issue
 * via trigram semantic similarity matching — no regex needed.
 */
export interface HeuristicRule {
  /** Unique rule ID (e.g., "security/sql-injection") */
  id: string;
  /** Short human-readable name */
  name: string;
  /** Category */
  category: Category;
  /** Default severity */
  severity: Severity;
  /** CWE ID if applicable */
  cwe?: string;
  /** OWASP category (e.g., "A03:2021-Injection") */
  owasp?: string;
  /** Description of the vulnerability */
  description: string;
  /** Suggested fix */
  suggestion: string;
  /** Languages this rule applies to */
  languages: HeuristicLanguage[];
  /**
   * ★ Semantic descriptors for trigram matching.
   *
   * Each string is a natural language description of a vulnerable code pattern.
   * The trigram vectors of all descriptors are combined (via textToVector)
   * and compared against code chunk vectors via cosine similarity.
   *
   * Example:
   *   "SQL query built by string concatenation with user input variable"
   *   "database query method called with template literal containing interpolation"
   *
   * Descriptors should be concrete enough to produce distinctive trigram patterns,
   * but general enough to catch syntactic variants of the same vulnerability.
   */
  descriptors: string[];
  /** Tags for filtering */
  tags?: string[];
}

/** Result of matching a rule against a code chunk */
export interface RuleMatch {
  rule: HeuristicRule;
  /** Which chunk text triggered the match */
  chunkText: string;
  /** Trigram cosine similarity score (0–1), used as confidence */
  confidence: number;
}
