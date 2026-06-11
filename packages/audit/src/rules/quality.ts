// ============================================================
// Code Quality Rules
//
// ★ 正则已废弃。每条规则用 trigram 语义 descriptors 匹配。
// ============================================================

import type { HeuristicRule } from "./types.js";
import {
  EMPTY_CATCH_DESCRIPTORS,
  SWALLOWED_PROMISE_DESCRIPTORS,
  SYNC_FS_IN_SERVER_DESCRIPTORS,
  N_PLUS_ONE_QUERY_DESCRIPTORS,
  DEEP_NESTING_DESCRIPTORS,
  TOO_MANY_PARAMS_DESCRIPTORS,
} from "./descriptors.js";

// ---- Error Handling ----

export const RULE_EMPTY_CATCH: HeuristicRule = {
  id: "quality/empty-catch",
  name: "Empty Catch Block",
  category: "quality",
  severity: "medium",
  description: "Empty catch block silently swallows errors. This hides bugs, makes debugging difficult, and can leave the application in an inconsistent state.",
  suggestion: "At minimum, log the error. If the error is expected and safe to ignore, add a comment explaining why. Consider re-throwing or handling the error appropriately.",
  languages: ["ts", "js", "py", "go"],
  descriptors: EMPTY_CATCH_DESCRIPTORS,
  tags: ["error-handling", "catch", "silent-failure"],
};

export const RULE_SWALLOWED_PROMISE: HeuristicRule = {
  id: "quality/swallowed-promise",
  name: "Unhandled Promise / Swallowed Async Error",
  category: "quality",
  severity: "high",
  description: "Async function call without await or .catch(). The promise rejection will be silently lost (or crash the process in Node 16+).",
  suggestion: "Add await, .catch(), or .then() with error handling. Ensure every promise is either awaited or has explicit error handling.",
  languages: ["ts", "js"],
  descriptors: SWALLOWED_PROMISE_DESCRIPTORS,
  tags: ["async", "promise", "error-handling"],
};

// ---- Performance ----

export const RULE_SYNC_FS_IN_SERVER: HeuristicRule = {
  id: "perf/sync-fs-in-server",
  name: "Synchronous File I/O in Server Code",
  category: "perf",
  severity: "medium",
  description: "Synchronous filesystem operations (readFileSync, writeFileSync) in request handlers or server startup. These block the event loop, reducing throughput and increasing latency for all concurrent requests.",
  suggestion: "Use async fs methods (fs.promises.readFile, fs.writeFile with callbacks). If sync is unavoidable during startup only, add a comment explaining why.",
  languages: ["ts", "js"],
  descriptors: SYNC_FS_IN_SERVER_DESCRIPTORS,
  tags: ["performance", "blocking", "filesystem"],
};

export const RULE_N_PLUS_ONE: HeuristicRule = {
  id: "perf/n-plus-one-query",
  name: "N+1 Query Pattern",
  category: "perf",
  severity: "medium",
  description: "Database query inside a loop — this creates N+1 queries instead of one batched query, causing severe performance degradation as data grows.",
  suggestion: "Use batch queries (SELECT ... WHERE id IN (...)), eager loading (.include()/.populate()), or data loaders (GraphQL DataLoader).",
  languages: ["ts", "js", "py", "go"],
  descriptors: N_PLUS_ONE_QUERY_DESCRIPTORS,
  tags: ["performance", "database", "n+1"],
};

// ---- Maintainability ----

export const RULE_DEEP_NESTING: HeuristicRule = {
  id: "quality/deep-nesting",
  name: "Excessive Nesting Depth",
  category: "quality",
  severity: "low",
  description: "Code with deep nesting (>4 levels of if/for/while/callback) is hard to read, test, and maintain. Deep nesting often indicates the need for extraction or early returns.",
  suggestion: "Use early returns (guard clauses) to reduce nesting. Extract deeply nested logic into separate functions. Consider using async/await instead of nested callbacks.",
  languages: ["ts", "js", "py", "go"],
  descriptors: DEEP_NESTING_DESCRIPTORS,
  tags: ["maintainability", "nesting", "complexity"],
};

export const RULE_TOO_MANY_PARAMS: HeuristicRule = {
  id: "quality/too-many-params",
  name: "Function with Too Many Parameters",
  category: "quality",
  severity: "low",
  description: "Functions with more than 5 parameters are difficult to call correctly and understand. Consider grouping related parameters into an options object.",
  suggestion: "Group related parameters into a typed interface/struct. Use object destructuring with defaults. Split the function if it's doing too many things.",
  languages: ["ts", "js", "go"],
  descriptors: TOO_MANY_PARAMS_DESCRIPTORS,
  tags: ["maintainability", "parameters", "function-signature"],
};

// ---- All Quality Rules ----

export const QUALITY_RULES: HeuristicRule[] = [
  RULE_EMPTY_CATCH,
  RULE_SWALLOWED_PROMISE,
  RULE_SYNC_FS_IN_SERVER,
  RULE_N_PLUS_ONE,
  RULE_TOO_MANY_PARAMS,
];
