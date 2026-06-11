// ============================================================
// Rules Module — Exports
// ============================================================

export type { HeuristicRule, HeuristicLanguage, RuleMatch } from "./types.js";

export { SECURITY_RULES, RULE_SQL_INJECTION, RULE_NOSQL_INJECTION, RULE_COMMAND_INJECTION, RULE_CODE_INJECTION, RULE_XSS_DOM, RULE_XSS_REFLECTED, RULE_HARDCODED_SECRET, RULE_WEAK_CRYPTO, RULE_SSRF, RULE_PATH_TRAVERSAL, RULE_PROTOTYPE_POLLUTION, RULE_OPEN_REDIRECT, RULE_INSECURE_DESERIALIZATION, RULE_MISSING_CSRF, RULE_DEBUG_MODE, RULE_CORS_MISCONFIG } from "./security.js";

export { QUALITY_RULES, RULE_EMPTY_CATCH, RULE_SWALLOWED_PROMISE, RULE_SYNC_FS_IN_SERVER, RULE_N_PLUS_ONE, RULE_TOO_MANY_PARAMS } from "./quality.js";

export { detectLanguage, getRulesForLanguage, getAllRules, matchChunk, scanChunks } from "./engine.js";
