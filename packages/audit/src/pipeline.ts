// ============================================================
// AuditPipeline — rules → LLM discovers + adjudicates → report
//
// ★ LLM gets rules + project root + read-only tools.
//   Rules → Phase I discover → Phase II evidence → Phase III dialectic → Phase IV meta-audit.
// ============================================================

import { DialecticVerifier } from './dialectic/verifier.js';
import { generateVerificationReport } from './dialectic/verifier.js';
import { ALL_RULES, type RuleDefinition } from './dialectic/prompts.js';
import { loadConfig, deepMerge, type ComdrConfig } from './config.js';
import type { AuditedFinding } from './dialectic/types.js';
import type { AuditStats } from './interfaces.js';
import type { IToolExecutor } from './tools/executor.js';
import { DeepSeekClient } from '@comdr/llm';
import { THINKING_TYPE } from '@comdr/core';

// ---- Pipeline Result ----

export interface AuditReport {
  verifiedFindings: AuditedFinding[];
  stats: AuditStats;
  report: string;
}

export interface AuditOptions {
  targetDir?: string;
  /** Specific files to audit (if omitted, audit entire directory) */
  files?: string[];
  /** Specific rules to audit (if omitted, all rules) */
  rules?: RuleDefinition[];
  json?: boolean;
}

// ---- Pipeline ----

export class AuditPipeline {
  private verifier: DialecticVerifier;
  private config: ComdrConfig;

  /**
   * @param configOrRoot  Partial config override, or project root string
   * @param toolExecutor  ★ Injected from main engine. When provided, audit uses
   *                      the main Agent's native tools instead of standalone fs.
   *                      Omit for standalone CLI mode.
   */
  constructor(
    configOrRoot?: Partial<ComdrConfig> | string,
    toolExecutor?: IToolExecutor,
  ) {
    const projectRoot =
      typeof configOrRoot === 'string' ? configOrRoot : process.cwd();
    const configOverride =
      typeof configOrRoot === 'string' ? undefined : configOrRoot;

    this.config =
      configOverride && Object.keys(configOverride).length > 0
        ? deepMerge(loadConfig(projectRoot), configOverride)
        : loadConfig(projectRoot);

    const verifierConfig = {
      enabled: this.config.dialectic.enabled,
      maxFindingsPerRun: this.config.dialectic.maxFindingsPerRun,
      maxFindingsPerBatch: this.config.dialectic.maxFindingsPerBatch,
      phases: this.config.dialectic.phases,
    };

    if (toolExecutor) {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY required.');
      }
      const llm = new DeepSeekClient({
        apiKey,
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        maxTokens: 2000,
        thinking: { type: THINKING_TYPE.DISABLED },
      });
      this.verifier = new DialecticVerifier(verifierConfig, llm, toolExecutor);
    } else {
      this.verifier = DialecticVerifier.fromEnv(projectRoot, verifierConfig);
    }
  }

  /**
   * Run the full audit pipeline.
   */
  async run(options: AuditOptions = {}): Promise<AuditReport> {
    const startTime = Date.now();
    const targetDir = options.targetDir || process.cwd();
    const rules = options.rules || ALL_RULES;

    // LLM discovers + adjudicates findings from rules
    const verifiedFindings = await this.verifier.discoverRules(
      rules,
      targetDir,
      options.files,
    );

    // Build stats
    const durationMs = Date.now() - startTime;
    const stats: AuditStats = {
      findingsTotal: verifiedFindings.length,
      findingsConfirmed: verifiedFindings.filter((r) => r.verdict === 'confirmed').length,
      findingsWarning: verifiedFindings.filter((r) => r.verdict === 'warning').length,
      findingsDismissed: verifiedFindings.filter((r) => r.verdict === 'dismissed').length,
      durationMs,
      mode: 'llm',
      tokenUsageTotal: verifiedFindings.reduce((s, r) => s + (r.tokenUsage?.total || 0), 0),
    };

    // Generate report
    const report = generateVerificationReport(verifiedFindings);

    return { verifiedFindings, stats, report };
  }

  async runAndPrint(options: AuditOptions = {}): Promise<AuditReport> {
    const result = await this.run(options);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            verified: result.verifiedFindings,
            stats: result.stats,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(result.report);
    }

    const criticalCount = result.verifiedFindings.filter(
      (r) => r.finding.severity === 'critical' && r.verdict !== 'dismissed',
    ).length;
    const highCount = result.verifiedFindings.filter(
      (r) => r.finding.severity === 'high' && r.verdict !== 'dismissed',
    ).length;

    if (criticalCount + highCount > 0) {
      console.log(
        `\n⚠ ${criticalCount} critical + ${highCount} high severity findings require attention.`,
      );
    }

    // ★ Enforce failOnSeverity: exit 1 if findings at or above threshold
    const failThreshold = this.config.pipeline.failOnSeverity;
    const sevOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const threshold = sevOrder[failThreshold] ?? 3;
    const hasFailing = result.verifiedFindings.some(
      (r) => r.verdict !== 'dismissed' && (sevOrder[r.finding.severity] ?? 0) >= threshold,
    );
    if (hasFailing) {
      process.exitCode = 1;
    }

    return result;
  }
}
