// ============================================================
// Audit Dialectic Types — AEGIS 四阶段管线类型
// ============================================================

import type { Severity, Category, Verdict, Adjudication, Finding } from '../finding.js';

// ================================================================
// Phase I: Clue Discovery
// ================================================================

/** A suspicious location flagged by Phase I with worst-case taint assumption */
export interface ClueTuple {
  id: string;
  file: string;
  line: number;
  /** The actual suspicious statement/expression */
  statement: string;
  /** Which rule was triggered */
  rule: string;
  severity: Severity;
  category: Category;
  /** 0–1, how confident the LLM is that this is actually suspicious */
  confidence: number;
  /** Why the LLM flagged this — 1-2 sentence explanation */
  whySuspicious: string;
}

// ================================================================
// Phase II: Evidence Chain
// ================================================================

/** A single node in the data-flow evidence chain */
export interface EvidenceNode {
  file: string;
  line: number;
  /** The actual code at this node */
  code: string;
  /** Role in the data flow */
  role: 'source' | 'transform' | 'sink' | 'protection' | 'branch';
  /** What this node does in the context of the chain */
  description: string;
}

/** Structured evidence chain tracing data flow around a clue */
export interface EvidenceChain {
  clueId: string;
  /** Backward trace: data origin → suspicious line */
  backwardChain: EvidenceNode[];
  /** Forward trace: suspicious line → downstream sinks/effects */
  forwardChain: EvidenceNode[];
  /** Protections found at any point in the chain */
  protectionsFound: EvidenceNode[];
  /** Protections that SHOULD exist at specific points but are absent */
  protectionsMissing: Array<{
    /** Where in the chain the protection should be (file:line) */
    location: string;
    /** What protection is missing */
    expected: string;
  }>;
  /** Cross-file call boundaries traversed during tracing */
  crossFileBoundaries: Array<{
    from: string;
    to: string;
    callSite: string;
  }>;
  /** Did the LLM fully trace, or was it truncated by tool turn limit? */
  isComplete: boolean;
  /** Token usage for this phase */
  tokenUsage?: { total: number };
}

// ================================================================
// Phase III: Dialectical Verification
// ================================================================

/** A single step in the Red Team attack chain, anchored to code */
export interface AttackStep {
  /** Description of this attack step */
  step: string;
  /** File and line cited from the evidence chain */
  citedFile: string;
  citedLine: number;
}

/** A single defense argument, anchored to code */
export interface DefenseArg {
  /** The mitigation being argued */
  mitigation: string;
  /** File and line cited from the evidence chain */
  citedFile: string;
  citedLine: number;
}

/** Phase III output — Red/Blue dialectic + adjudication */
export interface DialecticResult {
  /** Neutral factual summary of what the code does */
  factualBasis: string;
  /** Red Team: attack chain steps, each anchored to evidence chain */
  attackSteps: AttackStep[];
  /** Blue Team: defense arguments, each anchored to evidence chain */
  defenseArgs: DefenseArg[];
  /** Final evidence-weighted adjudication */
  adjudication: Adjudication;
  /** Token usage */
  tokenUsage?: { total: number };
}

// ================================================================
// Phase IV: Meta-Audit
// ================================================================

/** Reasoning flaw categories from AEGIS */
export type FlawCategory =
  | 'phantom_mitigation'   // Cited a protection not in evidence chain
  | 'speculation'          // Made claims about code outside the chain
  | 'anchoring_failure'    // Ignored evidence present in the chain
  | 'over_trust';          // Treated unverified external call as safe

/** A detected reasoning flaw */
export interface ReasoningFlaw {
  category: FlawCategory;
  description: string;
  /** Where in the Phase III output the flaw was found */
  location: string;
}

/** Phase IV output — independent audit of Phase III reasoning */
export interface MetaAuditResult {
  judgment: 'agree' | 'disagree' | 'defer';
  flaws: ReasoningFlaw[];
  /** If disagree, explanation of why Phase III must be redone */
  vetoReason?: string;
  tokenUsage?: { total: number };
}

// ================================================================
// Full Verified Finding (all phases)
// ================================================================

/** The complete audit artifact — finding + evidence chain + dialectic + meta-audit */
export interface AuditedFinding {
  finding: Finding;
  verdict: Verdict;
  confidence: number;
  decisiveEvidence: string[];
  reasoning: string;
  mode: 'llm';
  /** Last completed phase */
  phase: 1 | 2 | 3 | 4;
  /** Phase II evidence chain */
  evidenceChain?: EvidenceChain;
  /** Phase III dialectic result */
  dialecticResult?: DialecticResult;
  /** Phase IV meta-audit result (skipped if dismissed) */
  metaAudit?: MetaAuditResult;
  /** Total token usage across all phases */
  tokenUsage?: { total: number };
}

// ================================================================
// Phase configuration
// ================================================================

export interface PhaseConfig {
  discover: {
    enabled: boolean;
    maxToolTurns: number;
  };
  evidence: {
    enabled: boolean;
    maxToolTurns: number;
  };
  dialectic: {
    enabled: boolean;
  };
  metaAudit: {
    enabled: boolean;
    /** Only run meta-audit on these verdicts */
    requireFor: Verdict[];
  };
}

export const DEFAULT_PHASE_CONFIG: PhaseConfig = {
  discover: { enabled: true, maxToolTurns: 10 },
  evidence: { enabled: true, maxToolTurns: 5 },
  dialectic: { enabled: true },
  metaAudit: {
    enabled: true,
    requireFor: ['confirmed', 'warning'],
  },
};
