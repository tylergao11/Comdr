// ============================================================
// Core Interfaces — audit pipeline contracts
// ============================================================

// ---- Stats ----

export interface AuditStats {
  findingsTotal: number;
  findingsConfirmed: number;
  findingsWarning: number;
  findingsDismissed: number;
  durationMs: number;
  mode: "llm";
  tokenUsageTotal?: number;
}
