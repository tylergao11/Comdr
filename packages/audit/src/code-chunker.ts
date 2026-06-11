// ============================================================
// CodeChunker — Semantic code chunking for trigram indexing
//
// Splits source files into semantically meaningful chunks
// (function bodies, class methods, logical blocks) rather
// than arbitrary line ranges.
//
// ★ 不再依赖正则做匹配——chunk 是检索单元，
//   trigram 语义相似度决定了 chunk 是否与某条规则相关。
// ============================================================

import * as fs from "fs";
import * as path from "path";
import type { HeuristicLanguage } from "./rules/types.js";
import { detectLanguage } from "./rules/engine.js";

// ---- Types ----

export interface CodeChunk {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ChunkerConfig {
  /** Minimum chunk size in characters (smaller chunks merged with previous) */
  minChunkChars: number;
  /** Maximum chunk size in characters (larger chunks split further) */
  maxChunkChars: number;
}

const DEFAULT_CONFIG: ChunkerConfig = {
  minChunkChars: 30,
  maxChunkChars: 2000,
};

// ---- Chunker ----

export class CodeChunker {
  private config: ChunkerConfig;

  constructor(config?: Partial<ChunkerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Chunk a single file into semantic blocks.
   */
  chunkFile(filePath: string): CodeChunk[] {
    const lang = detectLanguage(filePath);
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    const lines = source.split("\n");
    let rawChunks: Array<{ startLine: number; endLine: number }>;

    if (lang && ["ts", "tsx", "js", "jsx"].includes(lang)) {
      rawChunks = this.splitByFunctions(lines);
    } else if (lang === "py") {
      rawChunks = this.splitByPythonBlocks(lines);
    } else {
      rawChunks = this.splitByBlankLines(lines);
    }

    return this.buildChunks(filePath, lines, rawChunks);
  }

  /**
   * Chunk all files in a list.
   */
  chunkFiles(filePaths: string[]): CodeChunk[] {
    const allChunks: CodeChunk[] = [];
    for (const fp of filePaths) {
      allChunks.push(...this.chunkFile(fp));
    }
    return allChunks;
  }

  // ---- Splitting strategies ----

  /**
   * Split TS/JS by function/class/method boundaries.
   *
   * Heuristic (no AST dependency):
   *   - Lines starting with `export function`, `function`, `class`,
   *     `async function`, `const/let/var name = (...) =>`, etc.
   *   - Also splits at `if`, `for`, `while` at top-level indentation
   *     for block-level granularity.
   */
  private splitByFunctions(
    lines: string[],
  ): Array<{ startLine: number; endLine: number }> {
    const boundaries: number[] = [0]; // line 0 is always a boundary

    // Patterns that indicate a new logical block start
    const blockStartRe = /^(?:\s*)(?:export\s+)?(?:async\s+)?(?:function\s+\w|class\s+\w|const\s+\w+\s*=\s*(?:async\s*)?\(|\w+\s*:\s*(?:async\s*)?\(|if\s*\(|for\s*\(|while\s*\(|switch\s*\()/;
    // JSDoc / comment block before declarations
    const commentBlockRe = /^\s*\/\*\*|\*\/|\/\*\*/;

    let inComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Track comment blocks
      if (line.trim().startsWith("/*")) inComment = true;
      if (line.trim().includes("*/")) inComment = false;
      if (inComment) continue;

      // Skip single-line comments
      if (line.trim().startsWith("//")) continue;

      if (blockStartRe.test(line)) {
        // Only add boundary if we're not in the middle of a parameter list
        // (rough check: previous non-empty line doesn't end with comma or open paren)
        const prevNonEmpty = this.prevNonEmptyLine(lines, i);
        if (!prevNonEmpty || !/[,({]\s*$/.test(prevNonEmpty.trimEnd())) {
          boundaries.push(i);
        }
      }
    }

    return this.boundariesToRanges(boundaries, lines.length);
  }

  /**
   * Split Python by def/class and top-level blocks.
   */
  private splitByPythonBlocks(
    lines: string[],
  ): Array<{ startLine: number; endLine: number }> {
    const boundaries: number[] = [0];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Python block starts
      if (
        /^(?:async\s+)?def\s+\w/.test(trimmed) ||
        /^class\s+\w/.test(trimmed) ||
        /^@\w+/.test(trimmed) || // decorator
        trimmed.endsWith(":") && trimmed.length < 60 &&
        /^(?:if|for|while|with|try|except|elif|else)\b/.test(trimmed)
      ) {
        boundaries.push(i);
      }
    }

    return this.boundariesToRanges(boundaries, lines.length);
  }

  /**
   * Fallback: split by blank lines (paragraph mode).
   */
  private splitByBlankLines(
    lines: string[],
  ): Array<{ startLine: number; endLine: number }> {
    const boundaries: number[] = [0];

    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]!.trim();
      const curr = lines[i]!.trim();
      // Blank line between two non-blank lines = boundary
      if (prev === "" && curr !== "" && i > 0) {
        boundaries.push(i);
      }
    }

    return this.boundariesToRanges(boundaries, lines.length);
  }

  // ---- Utilities ----

  private boundariesToRanges(
    boundaries: number[],
    totalLines: number,
  ): Array<{ startLine: number; endLine: number }> {
    const ranges: Array<{ startLine: number; endLine: number }> = [];
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i]!;
      const end = i + 1 < boundaries.length ? boundaries[i + 1]! : totalLines;
      if (end - start > 0) {
        ranges.push({ startLine: start, endLine: end });
      }
    }
    return ranges;
  }

  private prevNonEmptyLine(lines: string[], currentIdx: number): string | null {
    for (let i = currentIdx - 1; i >= 0; i--) {
      const trimmed = lines[i]!.trim();
      if (trimmed !== "" && !trimmed.startsWith("//")) return trimmed;
    }
    return null;
  }

  /** Build CodeChunk objects from line ranges */
  private buildChunks(
    filePath: string,
    lines: string[],
    ranges: Array<{ startLine: number; endLine: number }>,
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const { minChunkChars, maxChunkChars } = this.config;

    for (const range of ranges) {
      const slice = lines.slice(range.startLine, range.endLine);
      const text = slice.join("\n");

      // Too small — skip (or merge with previous if possible)
      if (text.length < minChunkChars) {
        if (chunks.length > 0) {
          const prev = chunks[chunks.length - 1]!;
          prev.endLine = range.endLine;
          prev.text = lines.slice(prev.startLine, range.endLine).join("\n");
        }
        continue;
      }

      // Too large — split into sub-chunks
      if (text.length > maxChunkChars) {
        const subChunks = this.splitLargeRange(
          filePath,
          lines,
          range.startLine,
          range.endLine,
        );
        chunks.push(...subChunks);
        continue;
      }

      chunks.push({
        id: `${filePath}:${range.startLine}`,
        file: filePath,
        startLine: range.startLine + 1, // 1-based line numbers
        endLine: range.endLine,
        text,
      });
    }

    return chunks.filter(
      (c) => c.text.trim().length >= minChunkChars,
    );
  }

  private splitLargeRange(
    filePath: string,
    lines: string[],
    startLine: number,
    endLine: number,
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const { maxChunkChars } = this.config;
    let currentStart = startLine;
    let currentText = "";

    for (let i = startLine; i < endLine; i++) {
      const line = lines[i]!;
      if (currentText.length + line.length > maxChunkChars && currentText.length > 0) {
        chunks.push({
          id: `${filePath}:${currentStart}`,
          file: filePath,
          startLine: currentStart + 1,
          endLine: i,
          text: currentText,
        });
        currentStart = i;
        currentText = line;
      } else {
        currentText += (currentText ? "\n" : "") + line;
      }
    }

    // Final chunk
    if (currentText.trim()) {
      chunks.push({
        id: `${filePath}:${currentStart}`,
        file: filePath,
        startLine: currentStart + 1,
        endLine: endLine,
        text: currentText,
      });
    }

    return chunks;
  }
}

/** Convenience factory */
export function createChunker(config?: Partial<ChunkerConfig>): CodeChunker {
  return new CodeChunker(config);
}
