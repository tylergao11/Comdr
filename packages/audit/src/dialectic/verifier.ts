// ============================================================
// DialecticVerifier — Single-call structured evidence verification
//
// ★ 编排层不教 LLM 怎么想。提供代码 + trigram 证据标签，
//   LLM 自己判定。heuristic 模式走纯 trigram，0 token。
//
// 旧 3 步协议（Attack→Defense→Adjudicate）已删除。
// ============================================================

import type {
  Adjudication,
  CodeContext,
  DialecticInput,
  DialecticSession,
  Finding,
  Verdict,
} from "../finding.js";
import { DEFAULT_DIALECTIC_CONFIG, severityMeets } from "../finding.js";
import { debug } from "../debug.js";
import { LLMClient, type LLMConfig } from "../llm/client.js";
import { heuristicAdjudicate } from "./adjudicator.js";
import { extractCodeContext } from "../code-context.js";
import {
  detectByTrigram,
  SOURCE_DESCRIPTORS,
  SINK_DESCRIPTORS,
  PROTECTION_DESCRIPTORS,
} from "./evidence.js";
import { buildSystemPrompt, buildUserPrompt, type EvidenceLabels } from "./prompts.js";

export type { EvidenceLabels } from "./prompts.js";
export { extractCodeContext as extractCodeContextEnhanced } from "../code-context.js";

// ---- Result Types ----

export interface VerifierResult {
  finding: Finding;
  session: DialecticSession;
  mode: "heuristic" | "llm";
  tokenUsage?: { total: number };
}

/** Single-call LLM response — LLM decides its own reasoning path */
interface LLMVerdict {
  verdict: Verdict;
  confidence: number;
  decisiveEvidence: string[];
  reasoning: string;
}

// ---- Verifier ----

export interface DialecticVerifierConfig {
  enabled: boolean;
  triggerConditions: {
    minSeverity: string;
    minRuleConfidence: number;
  };
  maxFindingsPerRun: number;
  codeContext: {
    surroundingLines: number;
    includeCallChain: boolean;
  };
}

export class DialecticVerifier {
  private config: DialecticVerifierConfig;
  private llmClient: LLMClient | null;

  constructor(config?: Partial<DialecticVerifierConfig>, llmConfig?: Partial<LLMConfig>) {
    this.config = { ...DEFAULT_DIALECTIC_CONFIG, ...config } as DialecticVerifierConfig;
    try {
      this.llmClient = new LLMClient(llmConfig);
    } catch (err) {
      debug.warn("llm", "LLMClient init failed, heuristic-only mode", err);
      this.llmClient = null;
    }
  }

  shouldVerify(finding: Finding): boolean {
    if (!this.config.enabled) return false;
    if (!severityMeets(this.config.triggerConditions.minSeverity as Finding["severity"], finding.severity)) return false;
    if (finding.confidence >= this.config.triggerConditions.minRuleConfidence) return false;
    return true;
  }

  selectForVerification(findings: Finding[]): Finding[] {
    const sevOrder: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
    return findings
      .filter(f => this.shouldVerify(f))
      .sort((a, b) => {
        const aScore = (a.category === "security" ? 10 : 0) + (sevOrder[a.severity] || 0) * 2 + (1 - a.confidence) * 5;
        const bScore = (b.category === "security" ? 10 : 0) + (sevOrder[b.severity] || 0) * 2 + (1 - b.confidence) * 5;
        return bScore - aScore;
      })
      .slice(0, this.config.maxFindingsPerRun);
  }

  /**
   * Verify a finding.
   *
   * LLM mode: single call with structured evidence → verdict
   * Heuristic mode: pure trigram pattern matching, 0 token
   */
  async verify(input: DialecticInput, mode: "auto" | "llm" | "heuristic" = "auto"): Promise<VerifierResult> {
    const { finding, codeContext } = input;
    const canLLM = this.llmClient?.canCallLLM() ?? false;
    const useLLM = mode === "llm" || (mode === "auto" && canLLM);

    if (useLLM && this.llmClient) {
      return this.verifyLLM(finding, codeContext);
    }

    return this.verifyHeuristic(finding, codeContext);
  }

  // ---- LLM: single call ----

  private async verifyLLM(finding: Finding, ctx: CodeContext): Promise<VerifierResult> {
    // ★ Trigram evidence labels — no narrative, just tags
    const evidence = extractEvidenceLabels(ctx.surroundingCode);

    // ★ Split prompts: system = rule metadata (stable → KV Cache hit),
    //   user = finding-specific code + evidence
    const systemPrompt = buildSystemPrompt(finding);
    const userPrompt = buildUserPrompt(finding, ctx.surroundingCode, evidence);

    let verdict: LLMVerdict;
    try {
      const resp = await this.llmClient!.chatJSON<LLMVerdict>(
        systemPrompt,
        userPrompt,
        { model: this.llmClient!.getModel() },
      );
      verdict = resp;
    } catch (err) {
      debug.error("llm", "LLM call failed, falling back to heuristic", err);
      const adj = heuristicAdjudicate(finding, ctx.surroundingCode);
      return this.toResult(finding, adj, "heuristic");
    }

    const adjudication: Adjudication = {
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      decisiveEvidence: verdict.decisiveEvidence,
      reasoning: verdict.reasoning,
    };

    return {
      finding: {
        ...finding,
        verdict: adjudication.verdict,
        verdictReasoning: adjudication.reasoning,
        verdictEvidence: adjudication.decisiveEvidence,
        verdictConfidence: adjudication.confidence,
      },
      session: {
        factualBasis: { behavior: "", dataSources: evidence.sources, sinks: evidence.sinks, visibleProtections: evidence.protections, controlFlow: "" },
        attackArguments: [],
        defenseArguments: [],
        adjudication,
      },
      mode: "llm",
      tokenUsage: { total: 3000 }, // single call estimate
    };
  }

  // ---- Heuristic: pure trigram, 0 token ----

  private async verifyHeuristic(finding: Finding, ctx: CodeContext): Promise<VerifierResult> {
    const adjudication = heuristicAdjudicate(finding, ctx.surroundingCode);
    return this.toResult(finding, adjudication, "heuristic");
  }

  private toResult(finding: Finding, adj: Adjudication, mode: "heuristic" | "llm"): VerifierResult {
    return {
      finding: {
        ...finding,
        verdict: adj.verdict,
        verdictReasoning: adj.reasoning,
        verdictEvidence: adj.decisiveEvidence,
        verdictConfidence: adj.confidence,
      },
      session: {
        factualBasis: { behavior: "", dataSources: [], sinks: [], visibleProtections: [], controlFlow: "" },
        attackArguments: [],
        defenseArguments: [],
        adjudication: adj,
      },
      mode,
    };
  }

  async verifyAll(findings: Finding[]): Promise<VerifierResult[]> {
    const toVerify = this.selectForVerification(findings);
    const results: VerifierResult[] = [];
    for (const finding of toVerify) {
      const ctx = extractCodeContext(finding, undefined, undefined, this.config.codeContext.surroundingLines);
      const result = await this.verify({ finding, codeContext: ctx });
      results.push(result);
    }
    return results;
  }
}

// ---- Evidence extraction (trigram labels only, no narrative) ----

function extractEvidenceLabels(code: string): EvidenceLabels {
  return {
    sources: detectByTrigram(code, SOURCE_DESCRIPTORS, 0.30).map(m => m.descriptor.slice(0, 50)),
    sinks: detectByTrigram(code, SINK_DESCRIPTORS, 0.25).map(m => m.descriptor.slice(0, 50)),
    protections: detectByTrigram(code, PROTECTION_DESCRIPTORS, 0.30).map(m => m.descriptor.slice(0, 50)),
    crossRefs: [],
  };
}

// ---- Report formatting (unchanged) ----

import type { Verdict as V } from "../finding.js";

export function formatVerifiedFinding(result: VerifierResult): string {
  const { finding, session } = result;
  const adj = session.adjudication;
  const verdictIcon: Record<V, string> = { confirmed: "🔴 CONFIRMED", warning: "🟡 WARNING", dismissed: "🟢 DISMISSED" };
  return [
    `${verdictIcon[adj.verdict]} | ${finding.severity.toUpperCase()} | ${finding.category}`,
    `  Title: ${finding.title}`,
    `  File: ${finding.file}:${finding.line}`,
    `  Rule: ${finding.rule} (trigram confidence: ${finding.confidence.toFixed(2)})`,
    `  Verdict confidence: ${adj.confidence.toFixed(2)}`,
    `  Reasoning: ${adj.reasoning}`,
    adj.decisiveEvidence.length > 0 ? `  Key evidence:` : "",
    ...adj.decisiveEvidence.map(e => `    - ${e}`),
    finding.suggestion ? `  Suggestion: ${finding.suggestion}` : "",
    "",
  ].filter(l => l !== "").join("\n");
}

export function generateVerificationReport(results: VerifierResult[]): string {
  const confirmed = results.filter(r => r.session.adjudication.verdict === "confirmed");
  const warnings = results.filter(r => r.session.adjudication.verdict === "warning");
  const dismissed = results.filter(r => r.session.adjudication.verdict === "dismissed");
  const lines = [
    "=".repeat(60),
    "  Comdr-Audit Verification Report",
    "=".repeat(60),
    "",
    `Total verified: ${results.length} findings`,
    `  🔴 Confirmed: ${confirmed.length}`,
    `  🟡 Warning:   ${warnings.length}`,
    `  🟢 Dismissed: ${dismissed.length}`,
    `  Mode: ${results[0]?.mode === "llm" ? "LLM" : "Trigram heuristic"}`,
    "",
    "-".repeat(60), "",
  ];
  for (const r of [...confirmed, ...warnings, ...dismissed]) {
    lines.push(formatVerifiedFinding(r));
  }
  lines.push("-".repeat(60));
  return lines.join("\n");
}
