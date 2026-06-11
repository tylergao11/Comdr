// ============================================================
// Reporter — Format scan results into human-readable reports
// ============================================================

import type { Finding } from "../finding.js";
import type { ScanResult } from "./scanner.js";

export function formatScanReport(result: ScanResult): string {
  const { findings, stats } = result;
  const lines: string[] = [
    "=".repeat(60),
    "  Comdr-Audit Heuristic Scan Report",
    "=".repeat(60),
    "",
    `Files scanned:  ${stats.filesScanned}`,
    `Files skipped:  ${stats.filesSkipped}`,
    `Rules applied:  ${stats.rulesApplied}`,
    `Findings found: ${findings.length}`,
    `Duration:       ${stats.durationMs}ms`,
    "",
    "Findings by severity:",
    ...Object.entries(stats.findingsBySeverity)
      .sort((a, b) => {
        const sev: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
        return (sev[b[0]] || 0) - (sev[a[0]] || 0);
      })
      .map(([sev, count]) => `  ${sev.toUpperCase()}: ${count}`),
    "",
    "Findings by category:",
    ...Object.entries(stats.findingsByCategory)
      .map(([cat, count]) => `  ${cat}: ${count}`),
    "",
    "Top rules triggered:",
    ...Object.entries(stats.findingsByRule)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule, count]) => `  ${rule}: ${count}`),
    "",
    "-".repeat(60),
  ];

  if (findings.length > 0) {
    lines.push("", "## Findings", "");

    const severities: string[] = ["critical", "high", "medium", "low", "info"];
    for (const sev of severities) {
      const sevFindings = findings.filter(f => f.severity === sev);
      if (sevFindings.length === 0) continue;

      const icons: Record<string, string> = {
        critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪",
      };

      lines.push(`### ${icons[sev] || ""} ${sev.toUpperCase()} (${sevFindings.length})`, "");

      for (const f of sevFindings.slice(0, 20)) {
        lines.push(
          `  **${f.title}**`,
          `  File: ${f.file}:${f.line}  |  Rule: ${f.rule}  |  Confidence: ${(f.confidence * 100).toFixed(0)}%`,
          `  ${f.suggestion}`,
          "",
        );
      }

      if (sevFindings.length > 20) {
        lines.push(`  ... +${sevFindings.length - 20} more ${sev} findings`, "");
      }
    }
  }

  lines.push("-".repeat(60));
  lines.push(`Scan complete. ${findings.filter(f => f.severity === "critical" || f.severity === "high").length} high/critical findings need attention.`);

  return lines.join("\n");
}
