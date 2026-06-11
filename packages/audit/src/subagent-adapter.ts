/**
 * subagent-adapter.ts — @comdr/audit 子智能体适配器
 *
 * ★ 实现 ISubAgent 契约，暴露 audit 能力给主 Comdr 引擎。
 *   工具以 "audit__verify" / "audit__audit" 形式注册。
 *
 * ★ 工具执行器由主引擎注入——audit 不山寨文件系统工具。
 *   生命周期独立（四阶段管线），工具走主 Agent 原生通路。
 *
 * @agent Agent 5 — audit 子智能体
 */

import type { ToolDefinition, ToolResult } from '@comdr/core/types';
import type { ISubAgent, SubAgentManifest, IDeepSeekClient } from '@comdr/core/contracts';
import { DialecticVerifier } from './dialectic/verifier.js';
import type { IToolExecutor } from './tools/executor.js';
import type { Finding } from './finding.js';
import { loadConfig } from './config.js';
import { DeepSeekClient } from '@comdr/llm';
import { THINKING_TYPE } from '@comdr/core';

// ============================================================================
// §1 Manifest
// ============================================================================

const MANIFEST: SubAgentManifest = {
  name: 'audit',
  description: 'LLM-powered code security & quality audit — AEGIS 4-phase pipeline',
  version: '0.2.0',
  toolPrefix: 'audit',

  toolTopology: {
    verify: {
      layer: 'operate',
      domain: 'subagent',
      effect: 'execute',
      consumes: ['file_read', 'file_grep', 'file_glob', 'file_ls'],
      workflowHints: ['runs LLM dialectic verification on a finding'],
    },
    audit: {
      layer: 'operate',
      domain: 'subagent',
      effect: 'execute',
      consumes: ['file_read', 'file_grep', 'file_glob', 'file_ls'],
      workflowHints: ['runs full AEGIS 4-phase audit on a directory'],
    },
  },
};

// ============================================================================
// §2 Tool Definitions
// ============================================================================

const TOOLS: ToolDefinition[] = [
  {
    name: 'verify',
    description:
      'Verify a finding using LLM dialectic verification. The LLM gathers evidence via file_read/file_grep/file_glob and returns a verdict.',
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
    name: 'audit',
    description:
      'Run a full AEGIS 4-phase audit on a directory. Phase I discovers clues, II builds evidence chains, III dialectically verifies, IV meta-audits.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to audit' },
      },
      required: ['path'],
    },
    permission: 'read_only',
    timeoutMs: 300000,
  },
];

// ============================================================================
// §3 Adapter
// ============================================================================

export interface AuditSubAgentConfig {
  /** Project root for relative path resolution */
  projectRoot: string;
  /**
   * ★ Tool executor injected by the main Comdr engine.
   * When provided, audit uses the main Agent's native tools (file_read, file_grep, etc.)
   * instead of the standalone fs-based implementation.
   */
  toolExecutor?: IToolExecutor;
  /**
   * ★ LLM client injected by the main Comdr engine.
   * When provided, audit reuses the engine's LLM connection instead of creating its own.
   */
  llmClient?: IDeepSeekClient;
}

export class AuditSubAgent implements ISubAgent {
  private projectRoot: string;
  private toolExecutor: IToolExecutor | null;
  private llmClient: IDeepSeekClient | null;
  private _verifier: DialecticVerifier | null = null;

  constructor(config: AuditSubAgentConfig) {
    this.projectRoot = config.projectRoot;
    this.toolExecutor = config.toolExecutor ?? null;
    this.llmClient = config.llmClient ?? null;
  }

  get manifest(): SubAgentManifest {
    return MANIFEST;
  }

  getTools(): ToolDefinition[] {
    return TOOLS;
  }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
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

        const verifier = this.getVerifier();
        const result = await verifier.verify(finding);

        return {
          ok: true,
          callId: `audit-verify-${Date.now().toString(36)}`,
          toolName: 'audit__verify',
          content: JSON.stringify(
            {
              verdict: result.verdict,
              confidence: result.confidence,
              decisiveEvidence: result.decisiveEvidence,
              reasoning: result.reasoning,
            },
            null,
            2,
          ),
        };
      }

      case 'audit': {
        const { AuditPipeline } = await import('./pipeline.js');
        const pipeline = new AuditPipeline(this.projectRoot, this.toolExecutor ?? undefined);
        const report = await pipeline.run({
          targetDir: String(args.path ?? '.'),
        });

        return {
          ok: true,
          callId: `audit-audit-${Date.now().toString(36)}`,
          toolName: 'audit__audit',
          content: JSON.stringify(
            {
              stats: report.stats,
              findings: report.verifiedFindings.map((r) => ({
                title: r.finding.title,
                file: r.finding.file,
                line: r.finding.line,
                severity: r.finding.severity,
                verdict: r.verdict,
                reasoning: r.reasoning,
              })),
            },
            null,
            2,
          ),
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

  /**
   * ★ Lazily create and cache the verifier.
   * Uses main engine's tool executor when injected, loads config from comdr-audit.json.
   */
  private getVerifier(): DialecticVerifier {
    if (this._verifier) return this._verifier;

    const cfg = loadConfig(this.projectRoot);
    const phaseOverrides = {
      enabled: cfg.dialectic.enabled,
      maxFindingsPerRun: cfg.dialectic.maxFindingsPerRun,
      maxFindingsPerBatch: cfg.dialectic.maxFindingsPerBatch,
      phases: cfg.dialectic.phases,
    };

    // ★ 优先使用主引擎注入的 LLM client，避免重复创建
    if (this.llmClient && this.toolExecutor) {
      this._verifier = new DialecticVerifier(
        phaseOverrides,
        this.llmClient,
        this.toolExecutor,
      );
    } else if (this.toolExecutor) {
      // 回退：工具执行器由引擎注入但 LLM 未注入
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY required when engine LLM not injected.');
      }
      const llm = new DeepSeekClient({
        apiKey,
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        maxTokens: 2000,
        thinking: { type: THINKING_TYPE.DISABLED },
      });
      this._verifier = new DialecticVerifier(phaseOverrides, llm, this.toolExecutor);
    } else {
      this._verifier = DialecticVerifier.fromEnv(this.projectRoot, phaseOverrides);
    }

    return this._verifier;
  }
}

/**
 * ★ 工厂函数——实现 SubAgentFactory 契约。
 * @param config.projectRoot  项目根目录
 * @param config.toolExecutor 主引擎工具执行器（可选，有则走原生工具通路）
 */
export function createSubAgent(
  config?: Record<string, unknown>,
): ISubAgent {
  return new AuditSubAgent({
    projectRoot: (config?.projectRoot as string) || process.cwd(),
    toolExecutor: config?.toolExecutor as IToolExecutor | undefined,
    llmClient: config?.llmClient as IDeepSeekClient | undefined,
  });
}
