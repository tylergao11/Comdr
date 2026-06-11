// ============================================================
// Core Interfaces — contracts that all modules implement
//
// Consumers depend on these interfaces, not on concrete classes.
// This enables DI, testing, and swapping implementations
// (e.g., heuristic verifier ↔ LLM verifier).
// ============================================================

import type { Finding, Verdict, DialecticInput, SymbolRef, CallNode } from "./finding.js";

// ---- Rule Engine ----

export interface FileInput {
  path: string;
  source: string;
}

export interface IRuleEngine {
  /** All registered rules */
  readonly rules: ReadonlyArray<import("./rules/types.js").HeuristicRule>;

  /** Scan a single file, returning all triggered findings */
  scanFile(source: string, filePath: string): Finding[];

  /** Scan multiple files */
  scanFiles(files: FileInput[]): Finding[];

  /** Get rules applicable to a language */
  getRulesForLanguage(lang: string): import("./rules/types.js").HeuristicRule[];
}

// ---- Code Analyzer (per-language AST adapter) ----

export interface SourceNode {
  kind: string;
  text: string;
  line: number;
  column: number;
}

export interface SinkNode {
  kind: string;
  text: string;
  line: number;
  column: number;
}

export interface ProtectionNode {
  kind: string;
  text: string;
  line: number;
  column: number;
}

export interface AnalyzedCode {
  sources: SourceNode[];
  sinks: SinkNode[];
  protections: ProtectionNode[];
}

export interface FunctionContext {
  name: string;
  source: string;
  startLine: number;
  endLine: number;
}

export interface DataFlowPath {
  source: SymbolRef;
  transforms: Array<{ kind: string; text: string; line: number; column: number }>;
  sink: SinkNode;
  confidence: number;
}

export interface ICodeAnalyzer {
  readonly language: string;

  /** Parse and analyze a file for sources, sinks, protections */
  analyzeCode(filePath: string): AnalyzedCode;

  /** Extract all symbols from a file */
  extractSymbols(filePath: string): SymbolRef[];

  /** Get the enclosing function at a given line */
  getEnclosingFunction(filePath: string, line: number): FunctionContext | null;

  /** Trace data flow from source to sink within a file */
  traceDataFlow(filePath: string, sourceLine: number, sinkLine: number): DataFlowPath | null;
}

// ---- Verifier ----

export type VerifyMode = "auto" | "llm" | "heuristic";

export interface VerifierResult {
  finding: Finding;
  verdict: import("./finding.js").Verdict;
  confidence: number;
  decisiveEvidence: string[];
  reasoning: string;
  mode: "heuristic" | "llm";
  tokenUsage?: { total: number };
  prompts?: Record<string, string>;
}

export interface IVerifier {
  /** Should this finding be escalated to verification? */
  shouldVerify(finding: Finding): boolean;

  /** Filter and sort findings for verification */
  selectForVerification(findings: Finding[]): Finding[];

  /** Verify a single finding */
  verify(input: DialecticInput, mode?: VerifyMode): Promise<VerifierResult>;

  /** Verify multiple findings */
  verifyAll(findings: Finding[], mode?: VerifyMode): Promise<VerifierResult[]>;
}

// ---- Reporter ----

export interface AuditStats {
  filesScanned: number;
  filesSkipped: number;
  rulesApplied: number;
  findingsTotal: number;
  findingsBySeverity: Record<string, number>;
  findingsByCategory: Record<string, number>;
  durationMs: number;
  mode: "trigram" | "heuristic" | "llm" | "mixed";
  tokenUsageTotal?: number;
}

export interface IReporter {
  /** Format verified findings and stats into a report string */
  format(findings: Finding[], stats: AuditStats): string;
}
