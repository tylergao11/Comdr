// ============================================================
// Unified Configuration — single source of truth
// ============================================================

import * as fs from "fs";
import * as path from "path";
import type { Severity } from "./finding.js";
import type { PhaseConfig } from "./dialectic/types.js";
import { DEFAULT_PHASE_CONFIG } from "./dialectic/types.js";

// ---- Pipeline ----

export interface PipelineConfig {
  /** Exit code 1 if any finding at or above this severity */
  failOnSeverity: Severity;
}

// ---- Dialectic Verifier ----

export interface DialecticConfig {
  enabled: boolean;
  /** Max findings to return per run (cost control) */
  maxFindingsPerRun: number;
  /** Max findings per LLM batch call */
  maxFindingsPerBatch: number;
  /** Per-phase configuration */
  phases: PhaseConfig;
}

// ---- Unified Config ----

export interface ComdrConfig {
  /** File extensions to include in audit scope */
  extensions: string[];
  /** Directories to exclude */
  excludeDirs: string[];
  pipeline: PipelineConfig;
  dialectic: DialecticConfig;
}

// ---- Defaults ----

export const DEFAULT_COMDR_CONFIG: ComdrConfig = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go"],
  excludeDirs: ["node_modules", "dist", "build", ".git", "coverage", "temp", "overlay", "__pycache__"],

  pipeline: {
    failOnSeverity: "high",
  },

  dialectic: {
    enabled: true,
    maxFindingsPerRun: 50,
    maxFindingsPerBatch: 10,
    phases: DEFAULT_PHASE_CONFIG,
  },
};

// ---- Loader ----

/**
 * Load ComdrConfig from comdr-audit.json, merged with defaults.
 */
export function loadConfig(rootDir?: string): ComdrConfig {
  const base = rootDir || process.cwd();
  const cfgPath = path.resolve(base, "comdr-audit.json");

  let fileCfg: Partial<ComdrConfig> = {};
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (err) {
      console.error(`[comdr:config] WARNING: Failed to parse ${cfgPath}, using defaults. ${String(err)}`);
    }
  }

  return deepMerge(DEFAULT_COMDR_CONFIG, fileCfg);
}

/**
 * ★ Recursive deep merge — nested objects (e.g. dialectic.phases) are merged
 *   key-by-key rather than replaced wholesale.
 */
export function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result: any = { ...base };
  for (const key of Object.keys(override as object) as (keyof T)[]) {
    const baseVal = result[key];
    const overrideVal = override[key];
    if (isObject(baseVal) && isObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
