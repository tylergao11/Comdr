// ============================================================
// Rule Semantic Descriptors — Natural language descriptions
// of vulnerable patterns for trigram vector matching.
//
// ★ 每个 descriptor 对应旧 regex pattern 覆盖的代码模式。
//   Trigram 向量不依赖具体语法（SQL + var 和 query.concat(var)
//   在字符 trigram 层面高度相似），所以一条 descriptor 能覆盖
//   正则需要 5-10 条 pattern 才能覆盖的变体。
// ============================================================

// ---- A03:2021 — Injection ----

export const SQL_INJECTION_DESCRIPTORS = [
  "SQL query built by string concatenation with user input variable",
  "database query method called with template literal containing variable interpolation",
  "dynamic SQL statement construction using plus operator or concat with request parameters",
  "direct user input concatenated into SQL query string without parameterization",
  "raw SQL string assembled with unsanitized variables from HTTP request body query params",
  "SELECT INSERT UPDATE DELETE statement built by appending user controlled strings",
  "database execute query with unsafe string formatting from external input source",
];

export const NOSQL_INJECTION_DESCRIPTORS = [
  "MongoDB find query with user request body query params spread directly into filter object",
  "NoSQL query operator injection via unsanitized user input passed to database find method",
  "MongoDB where operator accepting JavaScript expression from untrusted source",
  "aggregation pipeline built from unvalidated HTTP request parameters",
  "user controlled object keys passed directly to NoSQL database query method",
];

export const COMMAND_INJECTION_DESCRIPTORS = [
  "shell command executed with string concatenation containing user variable",
  "child process exec function called with template literal interpolation from request input",
  "operating system command built by appending unsanitized external data to command string",
  "system shell spawned with user controlled arguments in command string",
  "execSync or spawn called with dynamic string constructed from HTTP parameters",
  "Python subprocess called with shell equals true and untrusted input",
  "Go exec Command with user supplied arguments to bash or sh shell",
];

export const CODE_INJECTION_DESCRIPTORS = [
  "eval function called with dynamic string argument potentially from user input",
  "Function constructor invoked with string parameter built from external data",
  "dynamic code execution via string evaluation of untrusted input",
  "setTimeout or setInterval called with string containing template literal variable",
  "compile function with exec mode on user controlled code string",
  "dynamic code evaluation without sandbox or allowlist validation",
];

// ---- XSS ----

export const XSS_DOM_DESCRIPTORS = [
  "innerHTML DOM property assigned with user controllable data",
  "outerHTML property set to value from HTTP request query or body parameters",
  "insertAdjacentHTML method called with unsanitized string from external input",
  "document write or writeln called with dynamic content from URL or user input",
  "React dangerouslySetInnerHTML prop set with data from request or localStorage",
  "Vue v-html directive bound to user input without sanitization",
  "HTML content injection into DOM element from untrusted data source",
];

export const XSS_REFLECTED_DESCRIPTORS = [
  "HTTP response send with request query parameters embedded in response body string",
  "user input from URL parameters reflected back in server response without escaping",
  "template rendering engine passed raw request data without HTML encoding",
  "JSON endpoint returning unsanitized user input from query string parameters",
  "request form data or URL args echoed in response using string concatenation",
  "Python Flask or Django returning user data in HTTP response without escape",
];

// ---- Sensitive Data Exposure ----

export const HARDCODED_SECRET_DESCRIPTORS = [
  "API key or secret key hardcoded as string literal in source code",
  "password or passwd variable assigned to plaintext string value",
  "authentication token or JWT secret stored as literal string in code",
  "private key PEM block embedded directly in source file",
  "AWS access key or secret key written as plaintext string constant",
  "GitHub personal access token exposed in source code",
  "database connection URL with embedded credentials hardcoded",
  "OpenAI or Stripe style API key in string literal",
  "cryptographic secret material in source code instead of environment variable",
];

export const WEAK_CRYPTO_DESCRIPTORS = [
  "MD5 hash function used for security sensitive operation",
  "SHA1 cryptographic hash used instead of SHA-256 or stronger",
  "DES or RC4 weak encryption algorithm used for data protection",
  "ECB block cipher mode used for encryption without authentication",
  "Math random used for generating passwords tokens or security values",
  "crypto createCipher without initialization vector or authentication tag",
  "hardcoded encryption key or static salt for password hashing",
  "weak random number generator used for cryptographic purposes",
];

// ---- SSRF ----

export const SSRF_DESCRIPTORS = [
  "fetch or HTTP request with URL from user request query parameters",
  "axios HTTP client called with URL from req query params or body",
  "server side HTTP request to URL controlled by external user input",
  "Python requests library called with URL from request args or form data",
  "urllib urlopen with URL constructed by concatenating user input string",
  "Go HTTP Get or Post with URL taken from request parameters",
  "outbound HTTP request from server to attacker controlled destination",
];

// ---- Path Traversal ----

export const PATH_TRAVERSAL_DESCRIPTORS = [
  "path join or resolve with user input from request query body or params",
  "filesystem readFile or writeFile with path containing user controlled segments",
  "file operation path built by concatenating strings with request input",
  "Python open function with file path from request args without validation",
  "Go os Open or ReadFile with path from HTTP request parameters",
  "directory traversal via unsanitized user input in file path construction",
  "filesystem access with path containing dot dot slash sequences from external input",
];

// ---- Prototype Pollution ----

export const PROTOTYPE_POLLUTION_DESCRIPTORS = [
  "Object assign with user request body query or params as source",
  "object spread operator with request body query or params into new object",
  "deep merge or extend function with user supplied object data",
  "bracket notation object property assignment with user controlled key name",
  "dynamic object key from untrusted input assigned value or merged into target",
  "prototype chain pollution via user controllable property name in assignment",
];

// ---- Open Redirect ----

export const OPEN_REDIRECT_DESCRIPTORS = [
  "HTTP redirect location taken from request query parameters without validation",
  "Express res redirect with URL from req query params or body",
  "Flask redirect function with destination from request args",
  "Go http Redirect with location URL from request input",
  "user controlled redirect target URL passed to response redirect method",
  "open redirect via unvalidated URL from query string parameter",
];

// ---- Deserialization ----

export const INSECURE_DESERIALIZATION_DESCRIPTORS = [
  "JSON parse of raw request body without schema validation or type checking",
  "unserialize or deserialize function called on untrusted user data",
  "Python pickle loads with data from HTTP request without integrity check",
  "YAML load with unsafe parser on user supplied input",
  "Go gob decoder on request body without type allowlist",
  "object deserialization from untrusted source without integrity verification",
];

// ---- CSRF ----

export const MISSING_CSRF_DESCRIPTORS = [
  "state changing HTTP POST PUT DELETE route defined without CSRF protection middleware",
  "API endpoint mutating server state without anti forgery token validation",
  "form submission handler without csrf token check or same site cookie",
  "Express route handler for POST PUT DELETE without csrf protection",
];

// ---- Quality ----

export const EMPTY_CATCH_DESCRIPTORS = [
  "empty catch block with no error handling logging or rethrow",
  "try catch where catch body is empty or only contains comment",
  "Python except block with only pass statement and no error logging",
  "silent error suppression in catch block without any handling",
  "exception caught and ignored without logging or recovery action",
];

export const SWALLOWED_PROMISE_DESCRIPTORS = [
  "async function call without await and without catch error handler",
  "promise then without catch chain leaving rejection unhandled",
  "floating promise not awaited or caught causing silent failure",
  "fire and forget async call with no error handling attached",
];

export const SYNC_FS_IN_SERVER_DESCRIPTORS = [
  "readFileSync or writeFileSync in request handler blocking event loop",
  "synchronous filesystem operation in server code path or API route",
  "blocking IO in web server request handler using sync fs methods",
  "existsSync mkdirSync rmdirSync in HTTP request processing pipeline",
];

export const N_PLUS_ONE_QUERY_DESCRIPTORS = [
  "database query inside for loop causing N+1 query performance problem",
  "ORM find or query method called inside array map or forEach iteration",
  "SQL execute inside loop instead of batch query with IN clause",
  "repeated database round trip per item in collection instead of eager loading",
];

export const TOO_MANY_PARAMS_DESCRIPTORS = [
  "function with more than five parameters making it hard to call correctly",
  "method signature with long parameter list needing options object refactoring",
  "function definition with six or more arguments in parameter list",
];

export const DEBUG_MODE_DESCRIPTORS = [
  "debug flag hardcoded to true in production server configuration",
  "Express error handler with showStack enabled exposing stack traces to users",
  "verbose error details or stack traces returned in API error responses",
  "NODE ENV not set to production or debug mode enabled in deployment",
  "Django Flask debug equals true without environment variable check",
];

export const CORS_MISCONFIG_DESCRIPTORS = [
  "CORS configured with wildcard star origin allowing requests from any domain",
  "Access Control Allow Origin header set to wildcard asterisk value",
  "CORS origin set to true which reflects any origin including malicious sites",
  "cross origin resource sharing allowing all origins with credentials enabled",
  "Python allow origin set to wildcard star in CORS middleware configuration",
];

// ---- Deep nesting / Too many params (structural, harder to catch) ----

export const DEEP_NESTING_DESCRIPTORS = [
  "deeply nested if else for while blocks exceeding four levels of indentation",
  "callback hell with nested anonymous functions deeper than four levels",
  "arrow function inside arrow function inside arrow function deeply indented",
  "excessive nesting depth making code hard to read test and maintain",
];

// ============================================================================
// § Aggregation — all descriptors keyed by rule ID for easy lookup
// ============================================================================

export const RULE_DESCRIPTORS: Record<string, string[]> = {
  "security/sql-injection": SQL_INJECTION_DESCRIPTORS,
  "security/nosql-injection": NOSQL_INJECTION_DESCRIPTORS,
  "security/command-injection": COMMAND_INJECTION_DESCRIPTORS,
  "security/code-injection": CODE_INJECTION_DESCRIPTORS,
  "security/xss-dom": XSS_DOM_DESCRIPTORS,
  "security/xss-reflected": XSS_REFLECTED_DESCRIPTORS,
  "security/hardcoded-secret": HARDCODED_SECRET_DESCRIPTORS,
  "security/weak-crypto": WEAK_CRYPTO_DESCRIPTORS,
  "security/ssrf": SSRF_DESCRIPTORS,
  "security/path-traversal": PATH_TRAVERSAL_DESCRIPTORS,
  "security/prototype-pollution": PROTOTYPE_POLLUTION_DESCRIPTORS,
  "security/open-redirect": OPEN_REDIRECT_DESCRIPTORS,
  "security/insecure-deserialization": INSECURE_DESERIALIZATION_DESCRIPTORS,
  "security/missing-csrf": MISSING_CSRF_DESCRIPTORS,
  "quality/empty-catch": EMPTY_CATCH_DESCRIPTORS,
  "quality/swallowed-promise": SWALLOWED_PROMISE_DESCRIPTORS,
  "perf/sync-fs-in-server": SYNC_FS_IN_SERVER_DESCRIPTORS,
  "perf/n-plus-one-query": N_PLUS_ONE_QUERY_DESCRIPTORS,
  "quality/deep-nesting": DEEP_NESTING_DESCRIPTORS,
  "quality/too-many-params": TOO_MANY_PARAMS_DESCRIPTORS,
  "security/debug-mode": DEBUG_MODE_DESCRIPTORS,
  "security/cors-misconfig": CORS_MISCONFIG_DESCRIPTORS,
};
