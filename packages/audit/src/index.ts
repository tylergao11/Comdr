// ============================================================
// @comdr/audit — Agent 5: Code Audit Engine
//
// ★ AEGIS 四阶段审计管线:
//   I - Clue Discovery (高召回，最坏污点假设)
//   II - Evidence Chain (封闭证据集，数据流追踪)
//   III - Dialectic Verify (Red/Blue/裁决，每claim锚定行号)
//   IV - Meta-Audit (独立审查，四类缺陷检测，可推翻)
// ============================================================

// Types
export type {
  Finding,
  Severity,
  Category,
  FindingSource,
  Verdict,
  Adjudication,
  VerifiedFinding,
} from './finding.js';
export { severityMeets, generateFindingId } from './finding.js';

// Phase types
export type {
  ClueTuple,
  EvidenceNode,
  EvidenceChain,
  AttackStep,
  DefenseArg,
  DialecticResult,
  FlawCategory,
  ReasoningFlaw,
  MetaAuditResult,
  AuditedFinding,
  PhaseConfig,
} from './dialectic/types.js';

// Rules (pure descriptions, fed to LLM as prompts)
export { ALL_RULES } from './dialectic/prompts.js';
export type { RuleDefinition } from './dialectic/prompts.js';

// Verifier
export { DialecticVerifier } from './dialectic/verifier.js';
export {
  formatVerifiedFinding,
  generateVerificationReport,
} from './dialectic/verifier.js';
export type { DialecticVerifierConfig } from './dialectic/verifier.js';

// Tools (read-only, shared with main agent)
export {
  StandaloneToolExecutor,
  createComdrToolExecutor,
  AUDIT_TOOLS,
} from './tools/executor.js';
export type { IToolExecutor } from './tools/executor.js';

// Pipeline
export { AuditPipeline } from './pipeline.js';

// SubAgent Adapter (ISubAgent contract — @comdr/engine registration)
export { AuditSubAgent, createSubAgent } from './subagent-adapter.js';

// ---- MCP Tool: comdr.verify ----

import type { Finding } from './finding.js';
import { DialecticVerifier } from './dialectic/verifier.js';

/** MCP Tool: comdr.verify — LLM dialectic verification on a finding */
export async function toolVerify(args: {
  title: string;
  severity: string;
  file: string;
  line: number;
  snippet: string;
}): Promise<string> {
  const finding: Finding = {
    id: `manual-${Date.now().toString(36)}`,
    severity: (args.severity as Finding['severity']) || 'medium',
    category: 'security',
    title: args.title,
    description: '',
    file: args.file,
    line: args.line,
    snippet: args.snippet,
    rule: 'manual',
    confidence: 0.5,
    source: 'static',
  };

  const verifier = DialecticVerifier.fromEnv(process.cwd());
  const result = await verifier.verify(finding);

  return JSON.stringify(
    {
      verdict: result.verdict,
      confidence: result.confidence,
      decisiveEvidence: result.decisiveEvidence,
      reasoning: result.reasoning,
    },
    null,
    2,
  );
}
