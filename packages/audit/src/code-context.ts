// ============================================================
// Code Context Extraction — Trigram cross-file retrieval
//
// ★ 替代旧 regex + AST 方案。
//   使用 TrigramIndex（由 scanner 构建的代码库 chunk 索引）
//   跨文件检索与 finding 语义相关的代码。
//
//   不再靠正则提取符号——trigram 向量自动找到
//   语义相关的函数、变量、sink、sanitizer。
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { debug } from "./debug.js";
import type { Finding, CodeContext, SymbolRef } from "./finding.js";
import { TrigramIndex, textToVector, cosineSimilarity } from "@comdr/core";
import type { CodeChunk } from "./rules/engine.js";

// ---- Descriptor vectors for source/sink/protection detection ----

/**
 * Semantic descriptors for data sources (user input, external data).
 * Trigram-matched against surrounding code to identify where data comes from.
 */
const SOURCE_DESCRIPTORS = [
  "HTTP request input from query parameters body cookies headers",
  "browser URL location search hash href pathname",
  "browser document cookie referrer localStorage sessionStorage",
  "filesystem read file input from disk",
  "external API response fetch axios HTTP get post",
  "environment variable process env configuration",
  "process argv stdin command line input",
  "postMessage event listener message from window",
];

/**
 * Semantic descriptors for dangerous sinks (where data goes that could be exploited).
 */
const SINK_DESCRIPTORS = [
  "eval function call dynamic code execution string argument",
  "Function constructor new Function dynamic code",
  "innerHTML outerHTML insertAdjacentHTML document write DOM injection HTML",
  "child process exec spawn execSync shell command execution",
  "database query execute SQL execution connection query",
  "filesystem writeFile appendFile write output file system",
  "JSON parse deserialization untrusted data object",
  "dynamic require import module loading from string",
  "HTTP response send sendFile redirect json render endpoint",
];

/**
 * Semantic descriptors for protection mechanisms (sanitization, validation).
 */
const PROTECTION_DESCRIPTORS = [
  "output encoding sanitization escapeHtml encodeURI htmlspecialchars sanitize DOMPurify",
  "input validation schema zod joi yup class-validator type guard safeParse",
  "parameterized query prepared statement execute with placeholder bind parameter",
  "authentication authorization guard middleware protect auth check",
  "type checking typeof instanceof isArray type assertion",
  "guard clause if condition return throw next error early exit",
  "CSRF token protection csurf same site cookie header check",
  "allowlist origin domain validation URL hostname check",
];

// ---- Extraction ----

/**
 * Extract enhanced code context using trigram cross-file retrieval.
 *
 * @param finding      The finding to build context for
 * @param index        TrigramIndex built from all codebase chunks
 * @param allChunks    All chunks (for retrieving full text of matches)
 * @param surroundingLines  Lines of surrounding code within the same file
 */
export function extractCodeContext(
  finding: Finding,
  index?: TrigramIndex,
  allChunks?: CodeChunk[],
  surroundingLines: number = 30,
): CodeContext {
  const absPath = path.resolve(finding.file);

  // Read file for surrounding code
  let surroundingCode = finding.snippet || "";
  try {
    const content = fs.readFileSync(absPath, "utf8");
    const allLines = content.split("\n");
    const startLine = Math.max(0, finding.line - surroundingLines);
    const endLine = Math.min(allLines.length, finding.line + surroundingLines);
    surroundingCode = allLines.slice(startLine, endLine).join("\n");
  } catch (err) {
    debug.warn("io", `Cannot read file for code context: ${absPath}`, err);
  }

  // Cross-file retrieval via trigram
  let relatedSymbols: SymbolRef[] = [];

  if (index && index.size > 0) {
    const queryText = `${finding.title} ${finding.description} ${finding.snippet}`;

    // Find relevant chunks from across the codebase
    const relevantChunks = index.search(queryText, 10, 0.1);

    relatedSymbols = relevantChunks
      .filter((doc) => doc.data)
      .map((doc) => {
        const chunk = doc.data as CodeChunk;
        return {
          name: chunk.file !== absPath
            ? `${path.basename(chunk.file)}:${chunk.startLine}`
            : `L${chunk.startLine}`,
          kind: chunk.file === absPath ? "function" : "import",
          file: chunk.file,
          line: chunk.startLine,
          description: chunk.text.slice(0, 80),
        };
      });

    // Detect sources/sinks/protections in surrounding code via descriptor trigram match
    const sources = detectPatterns(surroundingCode, SOURCE_DESCRIPTORS, "⚠ Data source", absPath, finding.line);
    const sinks = detectPatterns(surroundingCode, SINK_DESCRIPTORS, "⚡ Dangerous sink", absPath, finding.line);
    const protections = detectPatterns(surroundingCode, PROTECTION_DESCRIPTORS, "🛡 Protection", absPath, finding.line);

    relatedSymbols = [...sources, ...sinks, ...protections, ...relatedSymbols];
  }

  // Deduplicate related symbols by name
  const seen = new Set<string>();
  relatedSymbols = relatedSymbols.filter((s) => {
    const key = `${s.name}::${s.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    targetFile: finding.file,
    targetLine: finding.line,
    targetSnippet: finding.snippet || finding.description,
    surroundingCode,
    relatedSymbols: relatedSymbols.slice(0, 20),
    callChain: undefined,
  };
}

/**
 * Detect trigram patterns in code using descriptor vectors.
 *
 * For each descriptor, compute trigram cosine similarity against the code.
 * If above threshold, the descriptor's label is added to results.
 */
function detectPatterns(
  code: string,
  descriptors: string[],
  kindLabel: string,
  file: string,
  line: number,
): SymbolRef[] {
  if (!code || descriptors.length === 0) return [];

  const results: SymbolRef[] = [];
  const codeVec = textToVector(code);

  for (const desc of descriptors) {
    const descVec = textToVector(desc);
    const score = cosineSimilarity(codeVec, descVec);

    // Threshold tuned for source/sink/protection detection
    if (score > 0.35) {
      results.push({
        name: desc.slice(0, 60),
        kind: "variable",
        file,
        line,
        description: `${kindLabel} (trigram=${score.toFixed(2)})`,
      });
    }
  }

  return results;
}
