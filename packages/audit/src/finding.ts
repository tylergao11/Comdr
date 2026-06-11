// ============================================================
// Comdr-Audit Core Types — Finding & Dialectic Verification
// ============================================================

// ---- Finding (extends PLAN.md definition) ----

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "security" | "quality" | "perf" | "convention" | "bug";
export type FindingSource = "static" | "rag" | "agent" | "dynamic";
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
  confidence: number;       // 0–1, 规则/Agent 判定可信度
  source: FindingSource;
  /** Dialectic verification result (populated after verification pass) */
  verdict?: Verdict;
  verdictReasoning?: string;
  verdictEvidence?: string[];
  verdictConfidence?: number;
}

// ---- Dialectic Verification Types ----

/** Reference to a code symbol extracted from AST */
export interface SymbolRef {
  name: string;
  kind: "function" | "variable" | "class" | "import" | "type" | "method" | "parameter";
  file: string;
  line: number;
  /** Brief description from JSDoc or inference */
  description?: string;
}

/** A node in a simplified call chain */
export interface CallNode {
  functionName: string;
  file: string;
  line: number;
  args?: string[];
}

/** Code context extracted around a finding for dialectic analysis */
export interface CodeContext {
  targetFile: string;
  targetLine: number;
  /** The exact problematic snippet */
  targetSnippet: string;
  /** Surrounding code (±N lines) */
  surroundingCode: string;
  /** AST-extracted related symbols (variables, functions, imports) */
  relatedSymbols: SymbolRef[];
  /** Simplified call chain if available */
  callChain?: CallNode[];
}

/** Dialectic verification input */
export interface DialecticInput {
  finding: Finding;
  codeContext: CodeContext;
}

// ---- Dialectic Session (Aegis 4-step protocol) ----

/** Step 1: Factual understanding of the code */
export interface FactualBasis {
  /** What does this code do, factually */
  behavior: string;
  /** Identified data sources (user input, external data, internal) */
  dataSources: string[];
  /** Identified sinks (eval, SQL, filesystem, network, DOM) */
  sinks: string[];
  /** Any visible protection mechanisms */
  visibleProtections: string[];
  /** Relevant control flow summary */
  controlFlow: string;
}

/** Step 2: Attack argument */
export interface AttackArg {
  /** The attack vector being argued */
  vector: string;
  /** Detailed exploit chain */
  exploitChain: string;
  /** Required conditions for exploitability */
  preconditions: string[];
  /** How confident is this attack argument (0-1) */
  confidence: number;
}

/** Step 3: Defense argument */
export interface DefenseArg {
  /** Which attack argument this addresses (by index) */
  targetsAttackIndex: number;
  /** The defense mechanism or mitigating factor */
  mitigation: string;
  /** Evidence from the code */
  evidence: string;
  /** How confident is this defense (0-1) */
  confidence: number;
}

/** Step 4: Evidence-weighted adjudication */
export interface Adjudication {
  verdict: Verdict;
  /** Overall confidence in the verdict (0-1) */
  confidence: number;
  /** The decisive evidence that tipped the scale */
  decisiveEvidence: string[];
  /** Narrative reasoning for the verdict */
  reasoning: string;
}

export interface DialecticSession {
  factualBasis: FactualBasis;
  attackArguments: AttackArg[];
  defenseArguments: DefenseArg[];
  adjudication: Adjudication;
}

// ---- DialecticVerifier Configuration ----

export interface DialecticVerifierConfig {
  enabled: boolean;
  triggerConditions: {
    /** Minimum severity to trigger dialectic verification */
    minSeverity: Severity;
    /** Trigger when rule confidence is BELOW this value */
    minRuleConfidence: number;
  };
  /** Max findings to verify per run (cost control) */
  maxFindingsPerRun: number;
  codeContext: {
    /** Lines of surrounding code to include */
    surroundingLines: number;
    /** Whether to trace and include call chain */
    includeCallChain: boolean;
  };
}

export const DEFAULT_DIALECTIC_CONFIG: DialecticVerifierConfig = {
  enabled: true,
  triggerConditions: {
    minSeverity: "medium",
    minRuleConfidence: 0.8,
  },
  maxFindingsPerRun: 20,
  codeContext: {
    surroundingLines: 30,
    includeCallChain: true,
  },
};

// ---- Severity ordering for comparisons ----

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

/** Reset ID counter (for deterministic tests) */
export function resetIdCounter(): void {
  _idCounter = 0;
}
