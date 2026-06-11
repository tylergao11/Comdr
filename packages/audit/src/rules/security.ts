// ============================================================
// Security Rules — OWASP Top 10 + common CWEs
//
// ★ 正则已废弃。每条规则用 trigram 语义 descriptors 匹配，
//   不再使用 regex patterns。Descriptors 定义在 ./descriptors.ts。
// ============================================================

import type { HeuristicRule } from "./types.js";
import {
  SQL_INJECTION_DESCRIPTORS,
  NOSQL_INJECTION_DESCRIPTORS,
  COMMAND_INJECTION_DESCRIPTORS,
  CODE_INJECTION_DESCRIPTORS,
  XSS_DOM_DESCRIPTORS,
  XSS_REFLECTED_DESCRIPTORS,
  HARDCODED_SECRET_DESCRIPTORS,
  WEAK_CRYPTO_DESCRIPTORS,
  SSRF_DESCRIPTORS,
  PATH_TRAVERSAL_DESCRIPTORS,
  PROTOTYPE_POLLUTION_DESCRIPTORS,
  OPEN_REDIRECT_DESCRIPTORS,
  INSECURE_DESERIALIZATION_DESCRIPTORS,
  MISSING_CSRF_DESCRIPTORS,
  DEBUG_MODE_DESCRIPTORS,
  CORS_MISCONFIG_DESCRIPTORS,
} from "./descriptors.js";

// ---- A03:2021 — Injection ----

export const RULE_SQL_INJECTION: HeuristicRule = {
  id: "security/sql-injection",
  name: "SQL Injection",
  category: "security",
  severity: "critical",
  cwe: "CWE-89",
  owasp: "A03:2021-Injection",
  description: "SQL query built with string concatenation or template literals incorporating user input. Without parameterization, attackers can inject arbitrary SQL commands.",
  suggestion: "Use parameterized queries ($1, ?, :named) or an ORM with built-in query building. Never concatenate user input into SQL strings.",
  languages: ["ts", "js", "py", "go"],
  descriptors: SQL_INJECTION_DESCRIPTORS,
  tags: ["injection", "sql", "database"],
};

export const RULE_NOSQL_INJECTION: HeuristicRule = {
  id: "security/nosql-injection",
  name: "NoSQL Injection",
  category: "security",
  severity: "high",
  cwe: "CWE-943",
  owasp: "A03:2021-Injection",
  description: "NoSQL query built by spreading user input directly into query operators ($where, $gt, $ne). Attackers can inject MongoDB operators to bypass filters or extract data.",
  suggestion: "Sanitize user input before using in NoSQL queries. Use mongo-sanitize or mongoose's built-in validation. Never spread req.body/req.query directly into find() conditions.",
  languages: ["ts", "js"],
  descriptors: NOSQL_INJECTION_DESCRIPTORS,
  tags: ["injection", "nosql", "mongodb"],
};

export const RULE_COMMAND_INJECTION: HeuristicRule = {
  id: "security/command-injection",
  name: "Command Injection",
  category: "security",
  severity: "critical",
  cwe: "CWE-78",
  owasp: "A03:2021-Injection",
  description: "Shell command constructed with user-controlled input. Attackers can inject additional commands via shell metacharacters (;, |, &&, $()).",
  suggestion: "Use child_process.execFile() or spawn() with argument arrays. Never construct shell command strings with user input. If shell is unavoidable, use a library like shell-escape.",
  languages: ["ts", "js", "py", "go"],
  descriptors: COMMAND_INJECTION_DESCRIPTORS,
  tags: ["injection", "shell", "command"],
};

export const RULE_CODE_INJECTION: HeuristicRule = {
  id: "security/code-injection",
  name: "Code Injection (eval/Function)",
  category: "security",
  severity: "critical",
  cwe: "CWE-95",
  owasp: "A03:2021-Injection",
  description: "eval(), new Function(), or similar dynamic code execution found. If the input is user-controllable, this is a critical arbitrary code execution vulnerability.",
  suggestion: "Replace eval() with a safer alternative: JSON.parse for data deserialization, a sandboxed VM (vm2/isolated-vm) for dynamic code execution, or a proper expression parser.",
  languages: ["ts", "js", "py", "go"],
  descriptors: CODE_INJECTION_DESCRIPTORS,
  tags: ["injection", "code-exec", "eval"],
};

// ---- XSS ----

export const RULE_XSS_DOM: HeuristicRule = {
  id: "security/xss-dom",
  name: "DOM-based Cross-Site Scripting (XSS)",
  category: "security",
  severity: "high",
  cwe: "CWE-79",
  owasp: "A03:2021-Injection",
  description: "User-controllable data assigned to innerHTML, outerHTML, or passed to document.write(). This allows injection of arbitrary HTML/JavaScript into the page.",
  suggestion: "Use textContent or innerText for plain text. For HTML content, use DOMPurify or a server-side sanitizer. Never set innerHTML with unsanitized user data.",
  languages: ["ts", "js", "tsx", "jsx"],
  descriptors: XSS_DOM_DESCRIPTORS,
  tags: ["xss", "dom", "injection"],
};

export const RULE_XSS_REFLECTED: HeuristicRule = {
  id: "security/xss-reflected",
  name: "Reflected XSS (Server-Side)",
  category: "security",
  severity: "high",
  cwe: "CWE-79",
  owasp: "A03:2021-Injection",
  description: "User input reflected directly into HTTP response without escaping. This enables reflected XSS attacks where an attacker crafts a URL that injects scripts into the victim's browser.",
  suggestion: "Always HTML-encode user input before including it in responses. Use template engines with auto-escaping (React JSX, Handlebars, Jinja2 autoescape). Apply Content-Security-Policy headers.",
  languages: ["ts", "js", "py", "go"],
  descriptors: XSS_REFLECTED_DESCRIPTORS,
  tags: ["xss", "reflected", "server"],
};

// ---- Sensitive Data Exposure ----

export const RULE_HARDCODED_SECRET: HeuristicRule = {
  id: "security/hardcoded-secret",
  name: "Hardcoded Secret / Credential",
  category: "security",
  severity: "critical",
  cwe: "CWE-798",
  owasp: "A07:2021-Identification and Authentication Failures",
  description: "API key, password, token, or private key appears to be hardcoded in source code. These secrets will be exposed in version control and to anyone with code access.",
  suggestion: "Use environment variables (process.env.SECRET), a secrets manager (AWS Secrets Manager, HashiCorp Vault), or encrypted config files. Add the file to .gitignore if it contains real secrets.",
  languages: ["ts", "js", "py", "go"],
  descriptors: HARDCODED_SECRET_DESCRIPTORS,
  tags: ["secret", "credential", "hardcoded"],
};

export const RULE_WEAK_CRYPTO: HeuristicRule = {
  id: "security/weak-crypto",
  name: "Weak Cryptography",
  category: "security",
  severity: "high",
  cwe: "CWE-327",
  owasp: "A02:2021-Cryptographic Failures",
  description: "Use of broken or weak cryptographic algorithms (MD5, SHA1, DES, RC4) or hardcoded encryption keys. These provide no meaningful security.",
  suggestion: "Use SHA-256 or stronger for hashing, AES-256-GCM for encryption, bcrypt/argon2 for password hashing. Never hardcode encryption keys.",
  languages: ["ts", "js", "py", "go"],
  descriptors: WEAK_CRYPTO_DESCRIPTORS,
  tags: ["crypto", "weak-algorithm", "hash"],
};

// ---- SSRF ----

export const RULE_SSRF: HeuristicRule = {
  id: "security/ssrf",
  name: "Server-Side Request Forgery (SSRF)",
  category: "security",
  severity: "high",
  cwe: "CWE-918",
  owasp: "A10:2021-Server-Side Request Forgery",
  description: "User-controllable URL used in server-side HTTP requests. Attackers can make the server request internal resources (metadata services, internal APIs, localhost) that are normally inaccessible.",
  suggestion: "Validate and sanitize user-provided URLs. Use an allowlist of permitted domains. Block requests to internal IPs (127.0.0.1, 10.x, 192.168.x, 169.254.x). Use a dedicated HTTP client with SSRF protection.",
  languages: ["ts", "js", "py", "go"],
  descriptors: SSRF_DESCRIPTORS,
  tags: ["ssrf", "server-side", "request"],
};

// ---- Path Traversal ----

export const RULE_PATH_TRAVERSAL: HeuristicRule = {
  id: "security/path-traversal",
  name: "Path Traversal",
  category: "security",
  severity: "high",
  cwe: "CWE-22",
  owasp: "A01:2021-Broken Access Control",
  description: "User input used in filesystem path construction without proper validation. Attackers can use '../' sequences to access files outside the intended directory.",
  suggestion: "Resolve and validate the canonical path against an allowed base directory. Use path.resolve() then verify the result starts with the base path. Never use user input directly in path.join() or fs operations without validation.",
  languages: ["ts", "js", "py", "go"],
  descriptors: PATH_TRAVERSAL_DESCRIPTORS,
  tags: ["path-traversal", "filesystem", "directory"],
};

// ---- Prototype Pollution ----

export const RULE_PROTOTYPE_POLLUTION: HeuristicRule = {
  id: "security/prototype-pollution",
  name: "Prototype Pollution",
  category: "security",
  severity: "high",
  cwe: "CWE-1321",
  owasp: "A08:2021-Software and Data Integrity Failures",
  description: "Object property assignment with user-controlled keys may lead to prototype pollution. Attackers can inject properties like __proto__ or constructor.prototype to modify global object behavior.",
  suggestion: "Use Object.create(null) for maps, or use the Map data structure. Validate object keys against an allowlist. Avoid deep merge utilities on user-supplied objects. Use safe alternatives like lodash.merge with care.",
  languages: ["ts", "js"],
  descriptors: PROTOTYPE_POLLUTION_DESCRIPTORS,
  tags: ["prototype-pollution", "object", "injection"],
};

// ---- Open Redirect ----

export const RULE_OPEN_REDIRECT: HeuristicRule = {
  id: "security/open-redirect",
  name: "Open Redirect",
  category: "security",
  severity: "medium",
  cwe: "CWE-601",
  owasp: "A01:2021-Broken Access Control",
  description: "User-controllable URL used in redirect. Attackers can craft phishing links that appear to originate from your domain but redirect victims to malicious sites.",
  suggestion: "Validate redirect URLs against an allowlist. Use relative redirects. If absolute URLs are needed, parse and verify the hostname matches your domain.",
  languages: ["ts", "js", "py", "go"],
  descriptors: OPEN_REDIRECT_DESCRIPTORS,
  tags: ["redirect", "phishing", "open-redirect"],
};

// ---- Deserialization ----

export const RULE_INSECURE_DESERIALIZATION: HeuristicRule = {
  id: "security/insecure-deserialization",
  name: "Insecure Deserialization",
  category: "security",
  severity: "high",
  cwe: "CWE-502",
  owasp: "A08:2021-Software and Data Integrity Failures",
  description: "Untrusted data deserialized without validation. Attackers can craft serialized objects that execute code or manipulate application state when deserialized.",
  suggestion: "Avoid deserializing untrusted data. Use JSON (with schema validation) instead of native serialization formats. If native deserialization is required, use allowlist-based type validation and integrity checks (HMAC).",
  languages: ["ts", "js", "py", "go"],
  descriptors: INSECURE_DESERIALIZATION_DESCRIPTORS,
  tags: ["deserialization", "injection", "parsing"],
};

// ---- CSRF ----

export const RULE_MISSING_CSRF: HeuristicRule = {
  id: "security/missing-csrf",
  name: "Missing CSRF Protection",
  category: "security",
  severity: "medium",
  cwe: "CWE-352",
  owasp: "A01:2021-Broken Access Control",
  description: "State-changing endpoint (POST/PUT/DELETE) without visible CSRF protection. Attackers can forge cross-site requests that perform actions on behalf of authenticated users.",
  suggestion: "Use CSRF tokens (csurf, express-csurf). For SPAs, use SameSite cookie attribute + custom request header validation. For APIs, require custom headers (X-Requested-With) or use token-based auth.",
  languages: ["ts", "js", "py", "go"],
  descriptors: MISSING_CSRF_DESCRIPTORS,
  tags: ["csrf", "state-change", "forgery"],
};

// ---- Security Misconfiguration (from quality.ts) ----

export const RULE_DEBUG_MODE: HeuristicRule = {
  id: "security/debug-mode",
  name: "Debug Mode / Verbose Errors in Production",
  category: "security",
  severity: "medium",
  cwe: "CWE-489",
  owasp: "A05:2021-Security Misconfiguration",
  description: "Debug mode enabled or verbose error details exposed to users. This leaks stack traces, environment details, and internal logic to potential attackers.",
  suggestion: "Disable debug mode in production (NODE_ENV=production, DEBUG=False). Use generic error messages for users. Log detailed errors server-side only.",
  languages: ["ts", "js", "py", "go"],
  descriptors: DEBUG_MODE_DESCRIPTORS,
  tags: ["configuration", "debug", "information-leak"],
};

export const RULE_CORS_MISCONFIG: HeuristicRule = {
  id: "security/cors-misconfig",
  name: "CORS Misconfiguration",
  category: "security",
  severity: "medium",
  cwe: "CWE-942",
  owasp: "A05:2021-Security Misconfiguration",
  description: "CORS configured to allow all origins (Access-Control-Allow-Origin: *). This allows any website to make authenticated cross-origin requests, enabling CSRF-like attacks.",
  suggestion: "Restrict CORS to specific trusted origins. Never use '*' with credentials: true. Use a dynamic origin check against an allowlist for multi-tenant apps.",
  languages: ["ts", "js", "py", "go"],
  descriptors: CORS_MISCONFIG_DESCRIPTORS,
  tags: ["cors", "configuration", "misconfiguration"],
};

// ---- All Security Rules ----

export const SECURITY_RULES: HeuristicRule[] = [
  RULE_SQL_INJECTION,
  RULE_NOSQL_INJECTION,
  RULE_COMMAND_INJECTION,
  RULE_CODE_INJECTION,
  RULE_XSS_DOM,
  RULE_XSS_REFLECTED,
  RULE_HARDCODED_SECRET,
  RULE_WEAK_CRYPTO,
  RULE_SSRF,
  RULE_PATH_TRAVERSAL,
  RULE_PROTOTYPE_POLLUTION,
  RULE_OPEN_REDIRECT,
  RULE_INSECURE_DESERIALIZATION,
  RULE_MISSING_CSRF,
  RULE_DEBUG_MODE,
  RULE_CORS_MISCONFIG,
];
