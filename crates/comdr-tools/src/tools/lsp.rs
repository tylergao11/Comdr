/// LSP tool implementations — symbol search, diagnostics, code structure.
///
/// Uses regex-based parsing for initial implementation.
/// Full tree-sitter integration is planned as a follow-up for richer AST queries.
///
/// Current capabilities:
///   - `lsp_symbols`  — search for function/class/interface definitions by name
///   - `lsp_diagnostics` — basic file existence and syntax check
///   - `lsp_structure`   — extract code outline (imports, functions, classes)

use std::sync::Arc;

use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};
use regex::Regex;
use serde_json::Value;
use std::fs;

/// Build and return all LSP-related tool instances.
pub fn register_all(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Arc::new(LspSymbolsTool));
    registry.register(Arc::new(LspDiagnosticsTool));
    registry.register(Arc::new(LspStructureTool));
}

// ============================================================================
// Language detection
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
enum Language {
    TypeScript,
    JavaScript,
    Rust,
    Python,
    Unknown,
}

impl Language {
    fn from_path(path: &str) -> Self {
        if path.ends_with(".ts") || path.ends_with(".tsx") {
            Language::TypeScript
        } else if path.ends_with(".js") || path.ends_with(".jsx") {
            Language::JavaScript
        } else if path.ends_with(".rs") {
            Language::Rust
        } else if path.ends_with(".py") {
            Language::Python
        } else {
            Language::Unknown
        }
    }
}

// ============================================================================
// lsp_symbols
// ============================================================================

struct LspSymbolsTool;

impl Tool for LspSymbolsTool {
    fn name(&self) -> &str {
        "lsp_symbols"
    }

    fn description(&self) -> &str {
        "Search for symbol definitions (functions, classes, interfaces) in source files."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File or directory to search for symbols"
                },
                "query": {
                    "type": "string",
                    "description": "Symbol name to search for (substring match)"
                }
            },
            "required": ["path"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        20000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let file_path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };

        let file_path = normalize_path(file_path);
        let lang = Language::from_path(&file_path);
        let query = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_lowercase());

        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot read '{}': {}", file_path, e),
                )
            }
        };

        let symbols = extract_symbols(&content, lang, &file_path);

        let filtered: Vec<&Symbol> = if let Some(ref q) = query {
            symbols
                .iter()
                .filter(|s| s.name.to_lowercase().contains(q))
                .collect()
        } else {
            symbols.iter().collect()
        };

        if filtered.is_empty() {
            let msg = if query.is_some() {
                format!("No symbols matching query found in '{}'.", file_path)
            } else {
                format!("No symbols found in '{}'.", file_path)
            };
            return ToolOutput::success(msg);
        }

        let mut output = String::new();
        for sym in filtered {
            output.push_str(&format!(
                "{}:{}  {:12}  {}\n",
                file_path, sym.line + 1, sym.kind, sym.name
            ));
        }
        ToolOutput::success(output)
    }
}

// ============================================================================
// lsp_diagnostics
// ============================================================================

struct LspDiagnosticsTool;

impl Tool for LspDiagnosticsTool {
    fn name(&self) -> &str {
        "lsp_diagnostics"
    }

    fn description(&self) -> &str {
        "Check a source file for basic diagnostics (syntax errors, parse issues)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to check for diagnostics"
                }
            },
            "required": ["path"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let file_path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };

        let file_path = normalize_path(file_path);
        let lang = Language::from_path(&file_path);

        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot read '{}': {}", file_path, e),
                )
            }
        };

        let diagnostics = check_diagnostics(&content, lang);

        if diagnostics.is_empty() {
            ToolOutput::success(format!("No diagnostics found in '{}'.", file_path))
        } else {
            let mut output = String::new();
            for d in &diagnostics {
                output.push_str(&format!(
                    "{}:{}  {:8}  {}\n",
                    file_path, d.line + 1, d.severity, d.message
                ));
            }
            ToolOutput::success(output)
        }
    }
}

// ============================================================================
// lsp_structure
// ============================================================================

struct LspStructureTool;

impl Tool for LspStructureTool {
    fn name(&self) -> &str {
        "lsp_structure"
    }

    fn description(&self) -> &str {
        "Show the code structure outline of a source file (imports, functions, classes, etc.)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to analyze"
                }
            },
            "required": ["path"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let file_path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };

        let file_path = normalize_path(file_path);
        let lang = Language::from_path(&file_path);

        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot read '{}': {}", file_path, e),
                )
            }
        };

        let structure = extract_structure(&content, lang);

        let mut output = format!("Structure of '{}':\n\n", file_path);

        if let Some(ref imports) = structure.imports {
            if !imports.is_empty() {
                output.push_str("── Imports ──\n");
                for imp in imports {
                    output.push_str(&format!("  {}\n", imp));
                }
                output.push('\n');
            }
        }

        if !structure.symbols.is_empty() {
            output.push_str("── Symbols ──\n");
            for sym in &structure.symbols {
                let indent = "  ";
                output.push_str(&format!(
                    "{}{}:{}  {:12}  {}\n",
                    indent, file_path, sym.line + 1, sym.kind, sym.name
                ));
            }
        }

        if structure.imports.as_ref().map_or(true, |i| i.is_empty()) && structure.symbols.is_empty() {
            output.push_str("(empty file or unable to parse structure)\n");
        }

        ToolOutput::success(output)
    }
}

// ============================================================================
// Symbol extraction
// ============================================================================

#[derive(Debug, Clone)]
struct Symbol {
    name: String,
    kind: String,
    line: usize,
}

struct FileStructure {
    imports: Option<Vec<String>>,
    symbols: Vec<Symbol>,
}

fn extract_symbols(content: &str, lang: Language, _file_path: &str) -> Vec<Symbol> {
    let mut symbols = Vec::new();

    for (line_num, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        match lang {
            Language::TypeScript | Language::JavaScript => {
                // function declarations
                if let Some(cap) = func_decl_ts().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "function".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // class declarations
                if let Some(cap) = class_decl_ts().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "class".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // interface declarations
                if let Some(cap) = interface_decl_ts().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "interface".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // const/let/var at top level
                if let Some(cap) = const_decl_ts().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "variable".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // type declarations
                if let Some(cap) = type_decl_ts().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "type".to_string(),
                        line: line_num,
                    });
                    continue;
                }
            }
            Language::Rust => {
                // fn declarations
                if let Some(cap) = fn_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "function".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // struct declarations
                if let Some(cap) = struct_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "struct".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // enum declarations
                if let Some(cap) = enum_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "enum".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // trait declarations
                if let Some(cap) = trait_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "trait".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // impl blocks
                if let Some(cap) = impl_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "impl".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // mod declarations
                if let Some(cap) = mod_decl_rs().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "module".to_string(),
                        line: line_num,
                    });
                    continue;
                }
            }
            Language::Python => {
                // def (function)
                if let Some(cap) = func_decl_py().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "function".to_string(),
                        line: line_num,
                    });
                    continue;
                }
                // class
                if let Some(cap) = class_decl_py().captures(trimmed) {
                    symbols.push(Symbol {
                        name: cap[1].to_string(),
                        kind: "class".to_string(),
                        line: line_num,
                    });
                    continue;
                }
            }
            Language::Unknown => {}
        }
    }

    symbols
}

fn extract_structure(content: &str, lang: Language) -> FileStructure {
    let symbols = extract_symbols(content, lang, "");
    let imports = extract_imports(content, lang);

    FileStructure {
        imports: if imports.is_empty() { None } else { Some(imports) },
        symbols,
    }
}

fn extract_imports(content: &str, lang: Language) -> Vec<String> {
    let mut imports = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        match lang {
            Language::TypeScript | Language::JavaScript => {
                if trimmed.starts_with("import ") || trimmed.starts_with("export ") && trimmed.contains(" from ") {
                    imports.push(trimmed.to_string());
                }
            }
            Language::Rust => {
                if trimmed.starts_with("use ") {
                    imports.push(trimmed.to_string());
                }
            }
            Language::Python => {
                if trimmed.starts_with("import ") || trimmed.starts_with("from ") {
                    imports.push(trimmed.to_string());
                }
            }
            Language::Unknown => {}
        }
    }
    imports
}

#[derive(Debug)]
struct Diagnostic {
    line: usize,
    severity: String,
    message: String,
}

fn check_diagnostics(content: &str, lang: Language) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    // Common checks across all languages
    for (i, line) in content.lines().enumerate() {
        // Detect common issues
        if line.contains("TODO") || line.contains("FIXME") {
            diagnostics.push(Diagnostic {
                line: i,
                severity: "info".to_string(),
                message: "TODO/FIXME comment".to_string(),
            });
        }
    }

    // Language-specific basic checks
    match lang {
        Language::TypeScript | Language::JavaScript => {
            // Check for unbalanced brackets
            let open_braces = content.matches('{').count();
            let close_braces = content.matches('}').count();
            if open_braces != close_braces {
                diagnostics.push(Diagnostic {
                    line: 0,
                    severity: "error".to_string(),
                    message: format!(
                        "Unbalanced braces: {} open, {} close",
                        open_braces, close_braces
                    ),
                });
            }
            let open_parens = content.matches('(').count();
            let close_parens = content.matches(')').count();
            if open_parens != close_parens {
                diagnostics.push(Diagnostic {
                    line: 0,
                    severity: "error".to_string(),
                    message: format!(
                        "Unbalanced parentheses: {} open, {} close",
                        open_parens, close_parens
                    ),
                });
            }
        }
        Language::Rust => {
            let open_braces = content.matches('{').count();
            let close_braces = content.matches('}').count();
            if open_braces != close_braces {
                diagnostics.push(Diagnostic {
                    line: 0,
                    severity: "error".to_string(),
                    message: format!(
                        "Unbalanced braces: {} open, {} close",
                        open_braces, close_braces
                    ),
                });
            }
        }
        _ => {}
    }

    diagnostics
}

// ============================================================================
// Regex patterns — compiled once via lazy statics
// ============================================================================

// TypeScript / JavaScript
fn func_decl_ts() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:export\s+)?(?:async\s+)?function\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn class_decl_ts() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:export\s+)?(?:abstract\s+)?class\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn interface_decl_ts() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:export\s+)?interface\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn const_decl_ts() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]").unwrap()) // static pattern — panic on invalid regex is correct
}

fn type_decl_ts() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:export\s+)?type\s+(\w+)\s*=").unwrap()) // static pattern — panic on invalid regex is correct
}

// Rust
fn fn_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:pub(?:\s*\(\s*crate\s*\))?\s+)?fn\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn struct_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:pub\s+)?struct\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn enum_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:pub\s+)?enum\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn trait_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:pub\s+)?trait\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn impl_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"impl\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn mod_decl_rs() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:pub\s+)?mod\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

// Python
fn func_decl_py() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"def\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

fn class_decl_py() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"class\s+(\w+)").unwrap()) // static pattern — panic on invalid regex is correct
}

// ============================================================================
// Helpers
// ============================================================================

use crate::utils::normalize_path;
