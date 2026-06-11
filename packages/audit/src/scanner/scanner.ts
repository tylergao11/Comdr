// ============================================================
// TrigramSemanticScanner — Trigram-powered audit scanner
//
// ★ 替代 HeuristicScanner。不再逐文件逐规则跑正则，
//   改为：文件 → CodeChunker → TrigramIndex → 规则 trigram 匹配。
//
// 管线:
//   collectFiles() → CodeChunker.chunkFiles() → TrigramIndex
//   → for each rule: search index by rule descriptors
//   → cosine similarity > threshold → Finding
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { debug } from "../debug.js";
import type { Finding } from "../finding.js";
import { getAllRules, scanChunks } from "../rules/engine.js";
import type { CodeChunk } from "../rules/engine.js";
import { CodeChunker, type ChunkerConfig } from "../code-chunker.js";
import { TrigramIndex } from "@comdr/core";
import { formatScanReport } from "./reporter.js";

// ---- Re-export for compat ----
export type { CodeChunk } from "../rules/engine.js";

// ---- Scanner Config ----

export interface ScannerConfig {
  /** Directories to scan */
  includeDirs: string[];
  /** Directories to exclude */
  excludeDirs: string[];
  /** File extensions to scan */
  extensions: string[];
  /** Max file size in bytes (skip larger files) */
  maxFileSize: number;
  /** Trigram cosine similarity threshold */
  matchThreshold: number;
  /** Code chunker config */
  chunker: ChunkerConfig;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  includeDirs: ["src", "packages", "lib", "app"],
  excludeDirs: ["node_modules", "dist", "build", ".git", "coverage", "__pycache__", "vendor", "temp"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go"],
  maxFileSize: 500_000,
  matchThreshold: 0.25,
  chunker: {
    minChunkChars: 30,
    maxChunkChars: 2000,
  },
};

// ---- Scan Result Types ----

export interface ScanResult {
  findings: Finding[];
  chunks: CodeChunk[];
  stats: ScanStats;
}

export interface ScanStats {
  filesScanned: number;
  filesSkipped: number;
  rulesApplied: number;
  findingsBySeverity: Record<string, number>;
  findingsByCategory: Record<string, number>;
  findingsByRule: Record<string, number>;
  durationMs: number;
}

// ---- Scanner ----

export class TrigramSemanticScanner {
  private config: ScannerConfig;
  private chunker: CodeChunker;

  constructor(config?: Partial<ScannerConfig>) {
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
    this.chunker = new CodeChunker(this.config.chunker);
  }

  /**
   * Scan a directory recursively.
   */
  scanDirectory(rootDir: string): ScanResult {
    const startTime = Date.now();
    const rules = getAllRules();

    // 1. Collect files
    const files = this.collectFiles(rootDir);

    // 2. Chunk & build TrigramIndex
    const chunks = this.buildChunks(files);

    // 3. Trigram match chunks → findings
    const findings = scanChunks(chunks, this.config.matchThreshold);

    // 4. Stats
    const stats = this.buildStats(files.length, files.length - chunks.length, rules.length, findings, startTime);

    return { findings, chunks, stats };
  }

  /**
   * Scan specific files (pre-commit / changed-files mode).
   */
  scanFiles(filePaths: string[]): ScanResult {
    const startTime = Date.now();
    const rules = getAllRules();

    const validFiles = filePaths.filter((fp) => {
      const ext = path.extname(fp);
      if (!this.config.extensions.includes(ext)) return false;
      try {
        const stat = fs.statSync(fp);
        if (stat.size > this.config.maxFileSize) return false;
        return true;
      } catch {
        return false;
      }
    });

    const chunks = this.buildChunks(validFiles);
    const findings = scanChunks(chunks, this.config.matchThreshold);
    const stats = this.buildStats(
      validFiles.length,
      filePaths.length - validFiles.length,
      rules.length,
      findings,
      startTime,
    );

    return { findings, chunks, stats };
  }

  // ---- Internals ----

  private buildChunks(files: string[]): CodeChunk[] {
    return this.chunker.chunkFiles(files);
  }

  private collectFiles(rootDir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(rootDir)) return results;

    const absRoot = path.resolve(rootDir);

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        debug.warn("scan", `Cannot read directory`, { dir, error: String(err) });
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (this.config.excludeDirs.includes(entry.name)) continue;
          if (entry.name.startsWith(".")) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (this.config.extensions.includes(ext)) {
            results.push(fullPath);
          }
        }
      }
    };

    walk(absRoot);
    return results;
  }

  private buildStats(
    filesScanned: number,
    filesSkipped: number,
    rulesApplied: number,
    findings: Finding[],
    startTime: number,
  ): ScanStats {
    const stats: ScanStats = {
      filesScanned,
      filesSkipped,
      rulesApplied,
      findingsBySeverity: {},
      findingsByCategory: {},
      findingsByRule: {},
      durationMs: Date.now() - startTime,
    };

    for (const f of findings) {
      stats.findingsBySeverity[f.severity] = (stats.findingsBySeverity[f.severity] || 0) + 1;
      stats.findingsByCategory[f.category] = (stats.findingsByCategory[f.category] || 0) + 1;
      stats.findingsByRule[f.rule] = (stats.findingsByRule[f.rule] || 0) + 1;
    }

    return stats;
  }

  /** Get the TrigramIndex built from scan results — for cross-file code context */
  getIndex(chunks: CodeChunk[]): TrigramIndex {
    const index = new TrigramIndex();
    for (const chunk of chunks) {
      index.add(chunk.id, chunk.text, chunk);
    }
    return index;
  }
}
