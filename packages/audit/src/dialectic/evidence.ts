// ============================================================
// Trigram Evidence Descriptors — Source/Sink/Protection detection
//
// ★ 替代旧 regex 方案。source/sink/protection 检测全走
//   trigram descriptor 向量余弦相似度。
//
//   每个 descriptor 是自然语言描述，其 trigram 向量与
//   代码文本做 cosine similarity > threshold → 检测到对应模式。
// ============================================================

import { textToVector, cosineSimilarity } from "@comdr/core";

// ---- Descriptor Vectors ----

/** Data sources — where untrusted data enters the system */
export const SOURCE_DESCRIPTORS: string[] = [
  "HTTP request input from query parameters body cookies headers params",
  "HTTP request metadata URL path hostname IP address origin",
  "browser URL location search hash href pathname host",
  "browser document cookie referrer domain storage",
  "localStorage getItem sessionStorage getItem browser storage",
  "filesystem readFile readFileSync read input from disk file",
  "external API response fetch axios HTTP get post put request",
  "environment variable process env configuration setting",
  "process argv stdin command line argument input",
  "postMessage event listener addEventListener message from window",
  "WebSocket message event onMessage socket data received",
  "user input form field textarea input onChange value",
];

/** Dangerous sinks — where data could be exploited */
export const SINK_DESCRIPTORS: string[] = [
  "eval function call dynamic code execution string argument runtime",
  "Function constructor new Function dynamic code generation",
  "innerHTML outerHTML assignment DOM property HTML content set",
  "insertAdjacentHTML document write writeln DOM injection",
  "dangerouslySetInnerHTML React prop JSX HTML injection",
  "child process exec execSync spawn shell command execution",
  "database query execute SQL statement connection pool",
  "filesystem writeFile appendFile writeFileSync output file system",
  "JSON parse deserialization from string to object",
  "dynamic require import module loading from string variable",
  "HTTP response send sendFile redirect json render res write",
  "setTimeout setInterval string argument code execution timer",
  "RegExp constructor dynamic regular expression from input",
];

/** Protection mechanisms — mitigations that reduce risk */
export const PROTECTION_DESCRIPTORS: string[] = [
  "output encoding sanitization escapeHtml encodeURI htmlspecialchars DOMPurify sanitize",
  "input validation schema zod joi yup class-validator type guard safeParse validate",
  "parameterized query prepared statement execute bind placeholder dollar param",
  "authentication authorization guard middleware protect auth check session token",
  "type checking typeof instanceof isArray type assertion narrowing",
  "guard clause if condition return throw error next early exit bail",
  "CSRF token protection csurf same site cookie strict lax header check",
  "allowlist origin domain validation URL hostname check whitelist",
  "ORM safe method createQueryBuilder find findOne save create repository",
  "path normalization resolve startsWith base directory validation traversal",
  "secure random crypto randomBytes randomUUID random generation",
  "Object freeze seal create null immutable safe map",
  "shell escape escapeShellArg arguments array instead of string",
  "CSP content security policy helmet header XSS protection",
  "integrity verification HMAC signature verify checksum",
  "environment variable config instead of hardcoded value",
  "promise catch error handler then reject async await",
  "batch query IN clause eager loading include populate prefetch DataLoader",
];

// ---- Trigram Detection ----

/**
 * Detect which descriptors match a given code text.
 *
 * @param code         Code text to analyze
 * @param descriptors  Descriptor strings to match against
 * @param threshold    Cosine similarity threshold (default 0.30)
 * @returns Array of {descriptor, score} for matches above threshold
 */
export function detectByTrigram(
  code: string,
  descriptors: string[],
  threshold: number = 0.30,
): Array<{ descriptor: string; score: number }> {
  if (!code || code.trim().length < 10) return [];

  const codeVec = textToVector(code);
  const results: Array<{ descriptor: string; score: number }> = [];

  for (const desc of descriptors) {
    const descVec = textToVector(desc);
    const score = cosineSimilarity(codeVec, descVec);
    if (score >= threshold) {
      results.push({ descriptor: desc, score });
    }
  }

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}

// ---- Presence checks (for adjudicator) ----

/**
 * Check if code text trigram-matches any descriptor in a list.
 * Returns true if at least one match found above threshold.
 */
export function hasPattern(
  code: string,
  descriptors: string[],
  threshold: number = 0.30,
): boolean {
  return detectByTrigram(code, descriptors, threshold).length > 0;
}

// ---- Specific pattern sets for heuristic adjudication ----

/** Sinks that indicate code execution */
export const CODE_EXEC_SINKS = [
  "eval function call dynamic code execution string argument runtime",
  "Function constructor new Function dynamic code generation",
  "setTimeout setInterval string argument code execution timer",
];

/** Sinks that indicate DOM injection */
export const DOM_INJECTION_SINKS = [
  "innerHTML outerHTML assignment DOM property HTML content set",
  "insertAdjacentHTML document write writeln DOM injection",
  "dangerouslySetInnerHTML React prop JSX HTML injection",
];

/** Sinks that indicate shell execution */
export const SHELL_EXEC_SINKS = [
  "child process exec execSync spawn shell command execution",
];

/** SQL execution sinks */
export const SQL_SINKS = [
  "database query execute SQL statement connection pool",
];

/** Strong protection patterns */
export const STRONG_PROTECTIONS = [
  "output encoding sanitization escapeHtml encodeURI htmlspecialchars DOMPurify sanitize",
  "input validation schema zod joi yup class-validator type guard safeParse validate",
  "parameterized query prepared statement execute bind placeholder dollar param",
];

/** Moderate protection patterns */
export const MODERATE_PROTECTIONS = [
  "authentication authorization guard middleware protect auth check session token",
  "type checking typeof instanceof isArray type assertion narrowing",
  "guard clause if condition return throw error next early exit bail",
  "CSRF token protection csurf same site cookie strict lax header check",
];
