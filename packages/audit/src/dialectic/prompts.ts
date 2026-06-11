// ============================================================
// Audit Prompts — Rule definitions + LLM discovery prompts
//
// ★ LLM 自己用工具搜证据，自己下结论。
//   编排层只提供规则描述 + 只读工具。
// ============================================================

import type { Severity, Category } from '../finding.js';

// ---- RuleDefinition ----

export interface RuleDefinition {
  id: string;
  name: string;
  category: Category;
  severity: Severity;
  cwe?: string;
  owasp?: string;
  /** Natural language description — LLM uses this to decide what to grep for */
  description: string;
  suggestion: string;
  languages: string[];
}

// ---- ALL_RULES (22 rules — 16 security + 6 quality) ----

export const ALL_RULES: RuleDefinition[] = [
  // ======== 🔴 CRITICAL (4) ========

  {
    id: 'security/sql-injection',
    name: 'SQL Injection',
    category: 'security',
    severity: 'critical',
    cwe: 'CWE-89',
    owasp: 'A03:2021-Injection',
    description:
      'SQL query built with string concatenation or template literals incorporating user input. Without parameterization, attackers can inject arbitrary SQL commands. Look for: query strings assembled with + or template literals containing variables named like req, params, body, input, user; database .execute() or .query() calls with raw SQL strings; missing parameterized queries (? or $1 placeholders).',
    suggestion:
      'Use parameterized queries ($1, ?, :named) or an ORM with built-in query building. Never concatenate user input into SQL strings.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/command-injection',
    name: 'Command Injection',
    category: 'security',
    severity: 'critical',
    cwe: 'CWE-78',
    owasp: 'A03:2021-Injection',
    description:
      'Shell command constructed with user-controlled input. Attackers can inject additional commands via shell metacharacters. Look for: child_process.exec(), execSync(), spawn() with shell:true; Python subprocess with shell=True; os.system(), os.popen(); command strings built from req.params, req.body, process.argv, or user input variables.',
    suggestion:
      'Use child_process.execFile() or spawn() with argument arrays. Never construct shell command strings with user input. If shell is unavoidable, use shell-escape.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/code-injection',
    name: 'Code Injection (eval/Function)',
    category: 'security',
    severity: 'critical',
    cwe: 'CWE-95',
    owasp: 'A03:2021-Injection',
    description:
      'Dynamic code execution via eval(), new Function(), setTimeout(string), setInterval(string), or compile() with user-controllable input. This is arbitrary code execution. Look for: eval() with non-literal arguments; new Function() with string args; Python exec()/compile(); template strings passed to code evaluation; user input reaching any dynamic code execution.',
    suggestion:
      'Replace eval() with JSON.parse for data, a sandboxed VM for dynamic execution, or a proper expression parser. Never execute user-supplied code strings.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/hardcoded-secret',
    name: 'Hardcoded Secret / Credential',
    category: 'security',
    severity: 'critical',
    cwe: 'CWE-798',
    owasp: 'A07:2021-Identification and Authentication Failures',
    description:
      'API key, password, token, or private key hardcoded in source code. Look for: assignments to variables named apiKey, secret, password, token, api_secret, privateKey, clientSecret, AUTH_TOKEN; string literals that look like base64-encoded keys or JWT tokens; AWS keys (AKIA...), GitHub tokens (ghp_...), Stripe keys (sk_live_...).',
    suggestion:
      'Use environment variables (process.env.SECRET) or a secrets manager. Add .env files to .gitignore. Rotate any exposed secrets immediately.',
    languages: ['ts', 'js', 'py', 'go'],
  },

  // ======== 🟠 HIGH (9) ========

  {
    id: 'security/nosql-injection',
    name: 'NoSQL Injection',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-943',
    owasp: 'A03:2021-Injection',
    description:
      'NoSQL query built by spreading user input directly into query operators ($where, $gt, $ne). Look for: MongoDB find() with req.body or req.query spread directly; $where operator with user input; Mongoose queries with unvalidated objects from request; user-controlled keys/operators in database filter objects.',
    suggestion:
      'Sanitize user input before NoSQL queries. Use mongo-sanitize or Mongoose validation. Never spread req.body/req.query directly into find() conditions.',
    languages: ['ts', 'js'],
  },
  {
    id: 'security/xss-dom',
    name: 'DOM-based Cross-Site Scripting (XSS)',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-79',
    owasp: 'A03:2021-Injection',
    description:
      'User-controllable data assigned to innerHTML, outerHTML, or passed to document.write(). Look for: .innerHTML = with variables from URL, location, postMessage, localStorage, or user input; document.write() with dynamic content; dangerouslySetInnerHTML in React/JSX without sanitization; Element.insertAdjacentHTML() with untrusted data.',
    suggestion:
      'Use textContent or innerText for plain text. For HTML content, use DOMPurify. In React, avoid dangerouslySetInnerHTML or sanitize first.',
    languages: ['ts', 'js', 'tsx', 'jsx'],
  },
  {
    id: 'security/xss-reflected',
    name: 'Reflected XSS (Server-Side)',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-79',
    owasp: 'A03:2021-Injection',
    description:
      'User input reflected directly into HTTP response without escaping. Look for: res.send() or res.write() with req.query/req.params values; template rendering with unescaped user input; Python/Flask render_template_string with user data; Go http.ResponseWriter with unsanitized input.',
    suggestion:
      'HTML-encode user input before including in responses. Use template engines with auto-escaping. Apply Content-Security-Policy headers.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/weak-crypto',
    name: 'Weak Cryptography',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-327',
    owasp: 'A02:2021-Cryptographic Failures',
    description:
      'Use of broken or weak cryptographic algorithms. Look for: MD5, SHA1, DES, RC4, 3DES usage; crypto.createHash("md5") or crypto.createCipher("des"); hardcoded encryption keys or IVs; Python hashlib.md5(); short key lengths; ECB mode encryption; missing salt in password hashing.',
    suggestion:
      'Use SHA-256+ for hashing, AES-256-GCM for encryption, bcrypt/argon2 for passwords. Never hardcode keys.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/ssrf',
    name: 'Server-Side Request Forgery (SSRF)',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-918',
    owasp: 'A10:2021-Server-Side Request Forgery',
    description:
      'User-controllable URL used in server-side HTTP requests. Look for: fetch(), axios(), request(), http.get() with URLs built from req.query/req.body; curl_exec() in PHP; urllib.request() in Python with user-supplied URLs; file downloads from user-provided URLs; webhook endpoints accepting arbitrary URLs.',
    suggestion:
      'Validate URLs with an allowlist of permitted domains. Block internal IPs. Use a dedicated HTTP client with SSRF protection.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/path-traversal',
    name: 'Path Traversal',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-22',
    owasp: 'A01:2021-Broken Access Control',
    description:
      'User input used in filesystem path construction. Look for: fs.readFile(), fs.createReadStream(), path.join() with req.params or req.query; Python open() with user-controlled paths; file serving endpoints where the filename comes from URL parameters; missing path.resolve() validation.',
    suggestion:
      'Resolve and validate the canonical path against an allowed base directory. Verify result starts with base path before filesystem access.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/prototype-pollution',
    name: 'Prototype Pollution',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-1321',
    owasp: 'A08:2021-Software and Data Integrity Failures',
    description:
      'Object property assignment with user-controlled keys. Look for: deep merge/extend/clone utilities called with user-supplied objects; Object.assign with req.body; lodash.merge/_.extend on untrusted data; spread operator on user objects with __proto__ risk; recursive object copy without hasOwnProperty checks.',
    suggestion:
      'Use Object.create(null) or Map for user-controlled key storage. Validate object keys. Avoid deep merge on user-supplied objects.',
    languages: ['ts', 'js'],
  },
  {
    id: 'security/insecure-deserialization',
    name: 'Insecure Deserialization',
    category: 'security',
    severity: 'high',
    cwe: 'CWE-502',
    owasp: 'A08:2021-Software and Data Integrity Failures',
    description:
      'Untrusted data deserialized without validation. Look for: JSON.parse() without schema validation on req.body; unserialize()/pickle.loads()/yaml.load() with user data; node-serialize or serialize-javascript usage; Java ObjectInputStream on network data; Python pickle on request data.',
    suggestion:
      'Use JSON with schema validation (Zod, Joi, Pydantic). Avoid native serialization of untrusted data. Use HMAC integrity checks.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'quality/swallowed-promise',
    name: 'Unhandled Promise / Swallowed Async Error',
    category: 'quality',
    severity: 'high',
    description:
      'Async function call without await or .catch(). Promise rejections silently lost. Look for: async function calls without await, .then(), or .catch(); floating promises in try/catch blocks (try {} catch won\'t catch unawaited promises); Promise.all without error handling; async callbacks without error propagation.',
    suggestion:
      'Add await, .catch(), or .then() with error handling. Ensure every promise is either awaited or has explicit error handling.',
    languages: ['ts', 'js'],
  },

  // ======== 🟡 MEDIUM (7) ========

  {
    id: 'security/open-redirect',
    name: 'Open Redirect',
    category: 'security',
    severity: 'medium',
    cwe: 'CWE-601',
    owasp: 'A01:2021-Broken Access Control',
    description:
      'User-controllable URL used in redirect. Look for: res.redirect() with req.query parameters; Location header set from user input; window.location = with URL parameters; returnTo/redirect/next query params used directly; Express redirect with unsanitized URL.',
    suggestion:
      'Validate redirect URLs against an allowlist. Use relative redirects. Parse and verify hostname for absolute URLs.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/debug-mode',
    name: 'Debug Mode / Verbose Errors in Production',
    category: 'security',
    severity: 'medium',
    cwe: 'CWE-489',
    owasp: 'A05:2021-Security Misconfiguration',
    description:
      'Debug mode enabled or verbose errors exposed. Look for: DEBUG=true, NODE_ENV=development in server code; stack traces in error responses; app.use(express.static) without proper config; debugger statements left in code; detailed SQL error messages exposed to client.',
    suggestion:
      'Disable debug mode in production. Use generic error messages for users. Log detailed errors server-side only.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/cors-misconfig',
    name: 'CORS Misconfiguration',
    category: 'security',
    severity: 'medium',
    cwe: 'CWE-942',
    owasp: 'A05:2021-Security Misconfiguration',
    description:
      'CORS configured to allow all origins. Look for: Access-Control-Allow-Origin: * with credentials:true; origin: "*" in CORS middleware config; dynamic origin reflection (echoing request origin without validation); missing CORS headers on API endpoints.',
    suggestion:
      'Restrict CORS to specific trusted origins. Never use * with credentials:true. Use an origin allowlist.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'security/missing-csrf',
    name: 'Missing CSRF Protection',
    category: 'security',
    severity: 'medium',
    cwe: 'CWE-352',
    owasp: 'A01:2021-Broken Access Control',
    description:
      'State-changing endpoint without CSRF protection. Look for: POST/PUT/DELETE routes without CSRF middleware; cookie-based auth on mutating endpoints without tokens; forms without CSRF hidden fields; Express apps without csurf or similar middleware.',
    suggestion:
      'Use CSRF tokens. For SPAs, use SameSite cookie + custom header. For APIs, require token-based auth.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'quality/empty-catch',
    name: 'Empty Catch Block',
    category: 'quality',
    severity: 'medium',
    description:
      'Empty catch block silently swallows errors. Look for: catch {} with empty body; catch(e) {} with no statements; except: pass in Python; try/catch where the error is completely ignored; catch blocks with only a comment.',
    suggestion:
      'At minimum, log the error. If the error is expected, add a comment explaining why. Consider re-throwing or handling appropriately.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'perf/sync-fs-in-server',
    name: 'Synchronous File I/O in Server Code',
    category: 'perf',
    severity: 'medium',
    description:
      'Synchronous filesystem ops in request handlers. Look for: readFileSync/writeFileSync inside route handlers; fs.existsSync in middleware; sync fs calls in async functions on server code paths; Python open() without async wrapper in web handlers.',
    suggestion:
      'Use async fs methods (fs.promises.readFile). If sync is unavoidable during startup only, add a comment.',
    languages: ['ts', 'js'],
  },
  {
    id: 'perf/n-plus-one-query',
    name: 'N+1 Query Pattern',
    category: 'perf',
    severity: 'medium',
    description:
      'Database query inside a loop. Look for: .find()/.query()/.execute() calls inside for/forEach/while/map loops; ORM queries inside iteration over array results; SQL queries built inside loop bodies; awaiting database calls per-item instead of batching.',
    suggestion:
      'Use batch queries (WHERE id IN (...)), eager loading (.include()/.populate()), or DataLoader pattern.',
    languages: ['ts', 'js', 'py', 'go'],
  },

  // ======== 🔵 LOW (2) ========

  {
    id: 'quality/deep-nesting',
    name: 'Excessive Nesting Depth',
    category: 'quality',
    severity: 'low',
    description:
      'Code with deep nesting (>4 levels of if/for/while/callback). Look for: deeply indented code blocks; nested callbacks (callback hell); multiple if/else chains 4+ deep; nested loops with conditional logic; try/catch inside if inside for inside try.',
    suggestion:
      'Use early returns (guard clauses) to reduce nesting. Extract deeply nested logic into separate functions. Use async/await instead of nested callbacks.',
    languages: ['ts', 'js', 'py', 'go'],
  },
  {
    id: 'quality/too-many-params',
    name: 'Function with Too Many Parameters',
    category: 'quality',
    severity: 'low',
    description:
      'Functions with more than 5 parameters. Look for: function signatures with 6+ parameters; methods with long parameter lists; callback with many positional args; constructors with many required arguments.',
    suggestion:
      'Group related parameters into a typed interface/struct. Use object destructuring with defaults. Split the function if it does too much.',
    languages: ['ts', 'js', 'go'],
  },
];

// ============================================================
// Single-Finding Verify (ad-hoc / manual use)
// ============================================================

import type { Finding } from '../finding.js';

/**
 * System prompt for single-finding verification.
 */
export function buildSingleVerifySystemPrompt(finding: Finding): string {
  return [
    'You are a code security auditor. Verify the following finding using read-only tools.',
    '',
    `<rule>${finding.rule} — ${finding.severity}</rule>`,
    `<description>${finding.description || 'No description provided.'}</description>`,
    '',
    'Use file_read, file_grep, file_glob to gather evidence, then output your verdict as JSON:',
    '{ "verdict": "confirmed" | "warning" | "dismissed", "confidence": 0.0, "decisiveEvidence": ["..."], "reasoning": "..." }',
  ].join('\n');
}

/**
 * User prompt for single-finding verification.
 */
export function buildSingleVerifyUserPrompt(finding: Finding): string {
  return [
    `<title>${finding.title}</title>`,
    `<file>${finding.file}:${finding.line}</file>`,
    `<snippet>${finding.snippet}</snippet>`,
    '',
    `Suggested fix: ${finding.suggestion || 'N/A'}`,
    '',
    'Investigate this finding with file_read and file_grep, then output your verdict.',
  ].join('\n');
}
