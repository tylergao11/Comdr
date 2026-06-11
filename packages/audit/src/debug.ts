// ============================================================
// Debug Logger — structured, togglable, audit-friendly
// ============================================================

const DEBUG_ENV = process.env.COMDR_DEBUG || "";
const DEBUG_CATEGORIES = new Set(
  DEBUG_ENV.split(",").map(s => s.trim()).filter(Boolean)
);

type Category = "scan" | "parse" | "llm" | "verify" | "config" | "io";

function enabled(cat: Category): boolean {
  return DEBUG_CATEGORIES.has(cat) || DEBUG_CATEGORIES.has("*");
}

export const debug = {
  /** Non-fatal operational issue (file skipped, parse failed, fallback used) */
  warn(cat: Category, msg: string, detail?: unknown): void {
    if (enabled(cat)) {
      const extra = detail !== undefined ? ` ${JSON.stringify(detail)}` : "";
      console.warn(`[comdr:${cat}] ${msg}${extra}`);
    }
  },

  /** Informational (scan progress, mode selection) */
  info(cat: Category, msg: string): void {
    if (enabled(cat)) {
      console.error(`[comdr:${cat}] ${msg}`);
    }
  },

  /** Fatal-ish but recovered (fallback activated) */
  error(cat: Category, msg: string, err?: unknown): void {
    // Always log errors — they indicate something worth knowing
    const detail = err instanceof Error ? err.message : String(err ?? "");
    console.error(`[comdr:${cat}:error] ${msg}${detail ? ` (${detail})` : ""}`);
  },
};
