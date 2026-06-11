// ============================================================
// AuditPipeline — composes scan → filter → verify → report
//
// ★ Trigram-powered pipeline.
//   Scanner builds TrigramIndex from code chunks,
//   code-context and verifier reuse the same index for
//   cross-file semantic retrieval.
// ============================================================

import { TrigramSemanticScanner } from "./scanner/index.js";
import type { ScanResult, ScannerConfig } from "./scanner/index.js";
import { DialecticVerifier } from "./dialectic/verifier.js";
import { formatScanReport } from "./scanner/index.js";
import { generateVerificationReport, formatVerifiedFinding } from "./dialectic/verifier.js";
import { extractCodeContext } from "./code-context.js";
import { loadConfig, type ComdrConfig } from "./config.js";
import type { Finding, Verdict } from "./finding.js";
import type { VerifyMode, AuditStats } from "./interfaces.js";
import type { CodeChunk } from "./code-chunker.js";

// ---- Pipeline Result ----

export interface VerifiedFinding {
  finding: Finding;
  verdict: Verdict;
  confidence: number;
  decisiveEvidence: string[];
  reasoning: string;
  mode: "heuristic" | "llm";
  tokenUsage?: { total: number };
}

export interface AuditReport {
  scanResult: ScanResult;
  verifiedFindings: VerifiedFinding[];
  stats: AuditStats;
  report: string;
}

export interface AuditOptions {
  targetDir?: string;
  files?: string[];
  verifyMode?: VerifyMode;
  json?: boolean;
}

// ---- Pipeline ----

export class AuditPipeline {
  private scanner: TrigramSemanticScanner;
  private verifier: DialecticVerifier;
  private config: ComdrConfig;

  constructor(config?: Partial<ComdrConfig>) {
    this.config = config && Object.keys(config).length > 0
      ? { ...loadConfig(), ...config } as ComdrConfig
      : loadConfig();
    this.scanner = new TrigramSemanticScanner(this.config.scanner);
    this.verifier = new DialecticVerifier(this.config.dialectic);
  }

  /**
   * Run the full audit pipeline.
   */
  async run(options: AuditOptions = {}): Promise<AuditReport> {
    const startTime = Date.now();

    // ---- Tier 0.5: Trigram Semantic Scan ----
    let scanResult: ScanResult;
    if (options.files && options.files.length > 0) {
      scanResult = this.scanner.scanFiles(options.files);
    } else {
      scanResult = this.scanner.scanDirectory(options.targetDir || process.cwd());
    }

    // Build TrigramIndex from all chunks — shared across verifier calls
    const index = this.scanner.getIndex(scanResult.chunks);

    // ---- Tier 1: Filter for verification ----
    let verifiedFindings: VerifiedFinding[] = [];
    const toVerify = this.verifier.selectForVerification(scanResult.findings);

    // ---- Tier 2: Dialectic verification ----
    if (toVerify.length > 0) {
      const mode = options.verifyMode || "heuristic";

      // ★ Group by rule → same system prompt → DeepSeek KV Cache hits
      const byRule = new Map<string, Finding[]>();
      for (const f of toVerify) {
        const list = byRule.get(f.rule) || [];
        list.push(f);
        byRule.set(f.rule, list);
      }

      for (const [, findings] of byRule) {
        for (const finding of findings) {
          const ctx = extractCodeContext(
            finding,
            index,
            scanResult.chunks,
            this.config.dialectic.codeContext.surroundingLines,
          );

          try {
            const result = await this.verifier.verify({ finding, codeContext: ctx }, mode);
            verifiedFindings.push({
              finding: result.finding,
              verdict: result.session.adjudication.verdict as Verdict,
              confidence: result.session.adjudication.confidence,
              decisiveEvidence: result.session.adjudication.decisiveEvidence,
              reasoning: result.session.adjudication.reasoning,
              mode: result.mode,
              tokenUsage: result.tokenUsage,
            });
          } catch (err) {
            verifiedFindings.push({
              finding,
              verdict: "warning",
              confidence: 0.5,
              decisiveEvidence: [`Verification error: ${String(err).slice(0, 100)}`],
              reasoning: "Verification failed — marked as warning for manual review.",
              mode: "heuristic",
            });
          }
        }
      }
    }

    // ---- Tier 3: Stats & Report ----
    const durationMs = Date.now() - startTime;
    const stats: AuditStats = {
      filesScanned: scanResult.stats.filesScanned,
      filesSkipped: scanResult.stats.filesSkipped,
      rulesApplied: scanResult.stats.rulesApplied,
      findingsTotal: scanResult.findings.length,
      findingsBySeverity: { ...scanResult.stats.findingsBySeverity },
      findingsByCategory: { ...scanResult.stats.findingsByCategory },
      durationMs,
      mode: verifiedFindings.some(r => r.mode === "llm") ? "mixed" : "trigram",
      tokenUsageTotal: verifiedFindings.reduce((s, r) => s + (r.tokenUsage?.total || 0), 0),
    };

    const scanReport = formatScanReport(scanResult);
    let verifyReport = "";
    if (verifiedFindings.length > 0) {
      verifyReport = generateVerificationReport(
        verifiedFindings.map(r => ({
          finding: r.finding,
          session: {
            factualBasis: { behavior: "", dataSources: [], sinks: [], visibleProtections: [], controlFlow: "" },
            attackArguments: [],
            defenseArguments: [],
            adjudication: {
              verdict: r.verdict,
              confidence: r.confidence,
              decisiveEvidence: r.decisiveEvidence,
              reasoning: r.reasoning,
            },
          },
          mode: r.mode,
          tokenUsage: r.tokenUsage,
        })),
      );
    }

    const report = [scanReport, verifyReport].filter(Boolean).join("\n\n");

    return { scanResult, verifiedFindings, stats, report };
  }

  async runAndPrint(options: AuditOptions = {}): Promise<AuditReport> {
    if (!options.verifyMode) {
      options.verifyMode = "heuristic";
    }

    const result = await this.run(options);

    if (options.json) {
      console.log(JSON.stringify({
        findings: result.scanResult.findings,
        verified: result.verifiedFindings,
        stats: result.stats,
      }, null, 2));
    } else {
      console.log(result.report);
    }

    const criticalCount = result.scanResult.findings.filter(f => f.severity === "critical").length;
    const highCount = result.scanResult.findings.filter(f => f.severity === "high").length;
    if (criticalCount + highCount > 0) {
      console.log(`\n⚠ ${criticalCount} critical + ${highCount} high severity findings require attention.`);
    }

    return result;
  }
}
