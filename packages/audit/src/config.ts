// ============================================================
// Unified Configuration — single source of truth
// Replaces scattered DEFAULT_*_CONFIG across the codebase.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import type { Severity } from "./finding.js";

// ---- Pipeline ----

export interface PipelineConfig {
  /** Which tiers to run: "static", "heuristic", "dialectic" */
  tiers: string[];
  /** Exit code 1 if any finding at or above this severity */
  failOnSeverity: Severity;
}

// ---- Scanner ----

export interface ScannerConfig {
  includeDirs: string[];
  excludeDirs: string[];
  extensions: string[];
  maxFileSize: number;
}

// ---- Rules ----

export interface RulesConfig {
  /** Rule IDs to skip entirely */
  disabled: string[];
  /** Override severity for specific rules */
  severityOverrides: Record<string, Severity>;
}

// ---- Dialectic Verifier ----

export interface DialecticConfig {
  enabled: boolean;
  triggerConditions: {
    minSeverity: Severity;
    minRuleConfidence: number; // Trigger when confidence is BELOW this
  };
  maxFindingsPerRun: number;
  codeContext: {
    surroundingLines: number;
    includeCallChain: boolean;
  };
}

// ---- LLM ----

export interface LLMConfig {
  provider: "anthropic" | "openai";
  apiKey?: string;
  baseUrl?: string;
  models: {
    dialectic: string;   // Haiku-level for attack/defense
    adjudicator: string; // Sonnet-level for final verdict
  };
  defaults: {
    maxTokens: number;
    temperature: number;
  };
}

// ---- Unified Config ----

export interface ComdrConfig {
  srcDir: string;
  excludeDirs: string[];
  extensions: string[];
  pipeline: PipelineConfig;
  scanner: ScannerConfig;
  rules: RulesConfig;
  dialectic: DialecticConfig;
  llm?: LLMConfig;
}

// ---- Defaults ----

export const DEFAULT_COMDR_CONFIG: ComdrConfig = {
  srcDir: "packages",
  excludeDirs: ["node_modules", "dist", "build", ".git", "coverage", "temp", "overlay", "__pycache__"],
  extensions: [".ts", ".tsx", ".js", ".jsx"],

  pipeline: {
    tiers: ["heuristic", "dialectic"],
    failOnSeverity: "high",
  },

  scanner: {
    includeDirs: ["src", "packages", "lib", "app"],
    excludeDirs: ["node_modules", "dist", "build", ".git", "coverage", "temp", "__pycache__"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go"],
    maxFileSize: 500_000,
  },

  rules: {
    disabled: [],
    severityOverrides: {},
  },

  dialectic: {
    enabled: true,
    triggerConditions: {
      minSeverity: "medium",
      minRuleConfidence: 0.8,
    },
    maxFindingsPerRun: 20,
    codeContext: {
      surroundingLines: 30,
      includeCallChain: true,
    },
  },
};

// ---- Loader ----

/**
 * Load ComdrConfig from comdr-audit.json, merged with defaults.
 * All config consumers should call this once at startup.
 */
export function loadConfig(rootDir?: string): ComdrConfig {
  const base = rootDir || process.cwd();
  const cfgPath = path.join(base, "comdr-audit.json");

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

function deepMerge(base: ComdrConfig, override: Partial<ComdrConfig>): ComdrConfig {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof ComdrConfig)[]) {
    const baseVal = result[key];
    const overrideVal = override[key];
    if (isObject(baseVal) && isObject(overrideVal)) {
      (result as Record<string, unknown>)[key] = { ...(baseVal as Record<string, unknown>), ...(overrideVal as Record<string, unknown>) };
    } else if (overrideVal !== undefined) {
      (result as Record<string, unknown>)[key] = overrideVal;
    }
  }
  return result;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
