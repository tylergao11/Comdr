// ============================================================
// Comdr-Audit Core Types — Finding & Verification Results
// ============================================================

// ---- Finding ----

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "security" | "quality" | "perf" | "convention" | "bug";
export type FindingSource = "static" | "rag" | "agent" | "dynamic" | "llm";
export type Verdict = "confirmed" | "warning" | "dismissed";

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  file: string;
  line: number;
  lineEnd?: number;
  snippet: string;
  rule: string;
  suggestion?: string;
  /** 0–1, LLM-assigned confidence */
  confidence: number;
  source: FindingSource;
}

// ---- Adjudication ----

export interface Adjudication {
  verdict: Verdict;
  /** Overall confidence in the verdict (0-1) */
  confidence: number;
  /** The decisive evidence that tipped the scale */
  decisiveEvidence: string[];
  /** Narrative reasoning for the verdict */
  reasoning: string;
}

// ---- Verified Finding (Finding + Adjudication together) ----

export interface VerifiedFinding {
  finding: Finding;
  verdict: Verdict;
  confidence: number;
  decisiveEvidence: string[];
  reasoning: string;
  mode: "llm";
  tokenUsage?: { total: number };
}

// ---- Severity ordering ----

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Check if a severity meets the minimum threshold */
export function severityMeets(min: Severity, actual: Severity): boolean {
  return SEVERITY_ORDER[actual] >= SEVERITY_ORDER[min];
}

/** Generate a unique finding ID */
let _idCounter = 0;
export function generateFindingId(rule: string): string {
  _idCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${rule}-${ts}-${rand}-${_idCounter}`;
}

