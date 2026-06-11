/**
 * subagent-adapter.ts — @comdr/audit 子智能体适配器
 *
 * ★ 实现 ISubAgent 契约，暴露 audit 能力给主 Comdr 引擎。
 *   工具以 "audit__scan" / "audit__verify" / "audit__rules" 形式注册。
 *
 * @agent Agent 5 — audit 子智能体
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentManifest } from '@comdr/core/contracts';
import { TrigramSemanticScanner } from './scanner/scanner.js';
import { formatScanReport } from './scanner/reporter.js';
import { DialecticVerifier } from './dialectic/verifier.js';
import { extractCodeContext } from './code-context.js';
import { getAllRules } from './rules/index.js';
import type { Finding } from './finding.js';

// ============================================================================
// §1 Manifest
// ============================================================================

const MANIFEST: SubAgentManifest = {
  name: 'audit',
  description: 'Code security & quality audit — heuristic scan + dialectic verification (21 OWASP/CWE rules)',
  version: '0.1.0',
  toolPrefix: 'audit',
};

// ============================================================================
// §2 Tool Definitions
// ============================================================================

const TOOLS: ToolDefinition[] = [
  {
    name: 'scan',
    description: 'Scan a directory for security vulnerabilities and code quality issues. Returns findings with severity, file, line, rule, and suggestion.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to scan' },
      },
      required: ['path'],
    },
    permission: 'read_only',
    timeoutMs: 60000,
  },
  {
    name: 'verify',
    description: 'Dialectic verify a finding — red team attack, blue team defense, adjudicator judgment. Returns verdict with confidence and reasoning.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        severity: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'number' },
        snippet: { type: 'string' },
      },
      required: ['title', 'severity', 'file', 'line', 'snippet'],
    },
    permission: 'read_only',
    timeoutMs: 30000,
  },
  {
    name: 'rules',
    description: 'List all registered audit rules with id, name, category, severity, CWE, and supported languages.',
    parameters: { type: 'object', properties: {} },
    permission: 'read_only',
    timeoutMs: 5000,
  },
];

// ============================================================================
// §3 Adapter
// ============================================================================

export class AuditSubAgent implements ISubAgent {
  get manifest(): SubAgentManifest {
    return MANIFEST;
  }

  getTools(): ToolDefinition[] {
    return TOOLS;
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (toolName) {
      case 'scan': {
        const scanner = new TrigramSemanticScanner();
        const result = scanner.scanDirectory(String(args.path ?? '.'));
        const report = formatScanReport(result);
        return {
          ok: true,
          callId: `audit-scan-${Date.now().toString(36)}`,
          toolName: 'audit__scan',
          content: JSON.stringify({
            findings: result.findings.map((f: Finding) => ({
              severity: f.severity, category: f.category, title: f.title,
              file: f.file, line: f.line, rule: f.rule, suggestion: f.suggestion,
            })),
            stats: result.stats,
            report,
          }, null, 2),
        };
      }

      case 'verify': {
        const finding: Finding = {
          id: `audit-${Date.now().toString(36)}`,
          severity: (args.severity as Finding['severity']) || 'medium',
          category: 'security',
          title: String(args.title ?? ''),
          description: '',
          file: String(args.file ?? ''),
          line: Number(args.line ?? 0),
          snippet: String(args.snippet ?? ''),
          rule: 'manual',
          confidence: 0.5,
          source: 'static',
        };
        const verifier = new DialecticVerifier();
        const ctx = extractCodeContext(finding);
        const result = await verifier.verify(
          { finding, codeContext: ctx },
          'heuristic',
        );
        return {
          ok: true,
          callId: `audit-verify-${Date.now().toString(36)}`,
          toolName: 'audit__verify',
          content: JSON.stringify({
            verdict: result.session.adjudication.verdict,
            confidence: result.session.adjudication.confidence,
            decisiveEvidence: result.session.adjudication.decisiveEvidence,
            reasoning: result.session.adjudication.reasoning,
          }, null, 2),
        };
      }

      case 'rules': {
        const rules = getAllRules();
        return {
          ok: true,
          callId: `audit-rules-${Date.now().toString(36)}`,
          toolName: 'audit__rules',
          content: JSON.stringify({
            count: rules.length,
            rules: rules.map((r) => ({
              id: r.id, name: r.name, category: r.category,
              severity: r.severity, cwe: r.cwe, languages: r.languages,
            })),
          }, null, 2),
        };
      }

      default:
        return {
          ok: false,
          callId: `audit-err-${Date.now().toString(36)}`,
          toolName: `audit__${toolName}`,
          content: `Unknown audit tool: ${toolName}`,
          errorCategory: 'execution_error',
        };
    }
  }
}

/**
 * ★ 工厂函数——实现 SubAgentFactory 契约。
 * Comdr 主引擎通过此函数创建 audit 子智能体实例。
 */
export function createSubAgent(_config?: Record<string, unknown>): ISubAgent {
  return new AuditSubAgent();
}
