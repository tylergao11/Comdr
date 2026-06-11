// ============================================================
// Rule Engine — Trigram Semantic Matching
//
// ★ 正则已废弃。规则匹配全部走 trigram cosine similarity。
//   每个 rule 的 descriptors 组成查询向量，
//   与 code chunk 向量做余弦相似度 → 超过阈值则触发。
// ============================================================

import type { Finding } from "../finding.js";
import { generateFindingId } from "../finding.js";
import { SECURITY_RULES } from "./security.js";
import { QUALITY_RULES } from "./quality.js";
import type { HeuristicRule, HeuristicLanguage, RuleMatch } from "./types.js";
import { textToVector, cosineSimilarity } from "@comdr/core";
import type { CodeChunk } from "../code-chunker.js";

// Re-export for consumers
export type { CodeChunk } from "../code-chunker.js";

// ---- Constants ----

/** Trigram cosine similarity threshold — below this, no match */
const MATCH_THRESHOLD = 0.25;

/** Detect file language from extension */
export function detectLanguage(filePath: string): HeuristicLanguage | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, HeuristicLanguage> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    py: "py", go: "go",
  };
  return ext ? map[ext] ?? null : null;
}

/** Get all rules applicable to a given language */
export function getRulesForLanguage(lang: HeuristicLanguage): HeuristicRule[] {
  return [...SECURITY_RULES, ...QUALITY_RULES].filter(r =>
    r.languages.includes(lang)
  );
}

/** Get all registered rules */
export function getAllRules(): HeuristicRule[] {
  return [...SECURITY_RULES, ...QUALITY_RULES];
}

// ---- Trigram Matching ----

/**
 * Match a rule against a code chunk using trigram cosine similarity.
 *
 * ★ Combines all rule descriptors into one query string,
 *   computes trigram vectors, and compares via cosine similarity.
 *   No regex — purely character-level semantic matching.
 *
 * @returns RuleMatch if cosine similarity > threshold, null otherwise
 */
export function matchChunk(
  rule: HeuristicRule,
  chunk: CodeChunk,
  minScore: number = MATCH_THRESHOLD,
): RuleMatch | null {
  // Combine rule descriptors + description into query text
  const queryText = `${rule.name} ${rule.description} ${rule.descriptors.join(" ")}`;
  const queryVec = textToVector(queryText);
  const chunkVec = textToVector(chunk.text);

  const score = cosineSimilarity(queryVec, chunkVec);

  if (score < minScore) return null;

  return {
    rule,
    chunkText: chunk.text,
    confidence: score,
  };
}

/**
 * Match a chunk against all applicable rules.
 * Returns findings for rules whose descriptors trigram-match the chunk.
 */
function matchChunkAgainstRules(
  chunk: CodeChunk,
  rules: HeuristicRule[],
  minScore: number = MATCH_THRESHOLD,
): Finding[] {
  const findings: Finding[] = [];

  for (const rule of rules) {
    const match = matchChunk(rule, chunk, minScore);
    if (match) {
      findings.push(ruleMatchToFinding(match, chunk));
    }
  }

  return findings;
}

/**
 * Convert a RuleMatch into a Finding for the pipeline.
 */
function ruleMatchToFinding(
  match: RuleMatch,
  chunk: CodeChunk,
): Finding {
  return {
    id: generateFindingId(match.rule.id),
    severity: match.rule.severity,
    category: match.rule.category,
    title: `${match.rule.name}`,
    description: match.rule.description,
    file: chunk.file,
    line: chunk.startLine,
    // ★ Snippet: first 200 chars of the matching chunk
    snippet: match.chunkText.slice(0, 200),
    rule: match.rule.id,
    suggestion: match.rule.suggestion,
    confidence: match.confidence,
    source: "static",
  };
}

/**
 * Scan all chunks with applicable rules per chunk's language.
 *
 * For each chunk:
 *   1. Detect language
 *   2. Get applicable rules
 *   3. For each rule: trigram cosine similarity
 *   4. Chunk above threshold → Finding
 *
 * @returns deduplicated Findings
 */
export function scanChunks(
  chunks: CodeChunk[],
  minScore: number = MATCH_THRESHOLD,
): Finding[] {
  const findings: Finding[] = [];

  for (const chunk of chunks) {
    const lang = detectLanguage(chunk.file);
    if (!lang) continue;

    const rules = getRulesForLanguage(lang);
    findings.push(...matchChunkAgainstRules(chunk, rules, minScore));
  }

  // ★ Deduplicate: same rule + same file + same line → keep highest confidence
  return deduplicateFindings(findings);
}

// ---- Deduplication ----

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();

  for (const f of findings) {
    const key = `${f.rule}::${f.file}::${f.line}`;
    const existing = seen.get(key);
    if (!existing || f.confidence > existing.confidence) {
      seen.set(key, f);
    }
  }

  return [...seen.values()];
}
