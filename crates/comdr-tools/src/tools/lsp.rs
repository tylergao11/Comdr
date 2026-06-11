/// LSP tool implementations — symbol search, diagnostics, code structure.
///
/// Uses tree-sitter AST parsing for accurate symbol extraction and diagnostics.
///
/// Current capabilities:
///   - `lsp_symbols`  — search for function/class/interface definitions by name
///   - `lsp_diagnostics` — syntax errors via tree-sitter ERROR nodes + TODO/FIXME detection
///   - `lsp_structure`   — extract code outline (imports, functions, classes)

use std::sync::Arc;

use crate::symbols::{self, SourceLanguage};
use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};
use serde_json::Value;
use std::fs;

/// Build and return all LSP-related tool instances.
pub fn register_all(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Arc::new(LspSymbolsTool));
    registry.register(Arc::new(LspDiagnosticsTool));
    registry.register(Arc::new(LspStructureTool));
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
        let lang = match symbols::language_from_ext(&file_path) {
            Some(l) => l,
            None => return ToolOutput::error("EXECUTION_FAILED", format!("Unsupported file type: '{}'", file_path)),
        };
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

        let symbols = extract_symbols(&content, lang);

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
        let lang = symbols::language_from_ext(&file_path);

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
        let lang = match symbols::language_from_ext(&file_path) {
            Some(l) => l,
            None => return ToolOutput::success(format!("Unsupported file type: '{}'", file_path)),
        };

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
// Symbol extraction (tree-sitter based)
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

/// Extract symbols using tree-sitter AST.
fn extract_symbols(content: &str, lang: SourceLanguage) -> Vec<Symbol> {
    let (extracted, _) = symbols::extract(content, lang);
    extracted
        .into_iter()
        .map(|s| Symbol {
            name: s.name,
            kind: s.kind,
            line: s.line,
        })
        .collect()
}

/// Extract imports using tree-sitter AST (returns raw import lines).
fn extract_imports(content: &str, lang: SourceLanguage) -> Vec<String> {
    symbols::extract_imports(content, lang)
}

fn extract_structure(content: &str, lang: SourceLanguage) -> FileStructure {
    let symbols = extract_symbols(content, lang);
    let imports = extract_imports(content, lang);

    FileStructure {
        imports: if imports.is_empty() { None } else { Some(imports) },
        symbols,
    }
}

#[derive(Debug)]
struct Diagnostic {
    line: usize,
    severity: String,
    message: String,
}

/// Run diagnostics using tree-sitter error nodes + TODO/FIXME detection.
fn check_diagnostics(content: &str, lang: Option<SourceLanguage>) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();

    // Common checks across all languages
    for (i, line) in content.lines().enumerate() {
        if line.contains("TODO") || line.contains("FIXME") {
            diagnostics.push(Diagnostic {
                line: i,
                severity: "info".to_string(),
                message: "TODO/FIXME comment".to_string(),
            });
        }
    }

    // Tree-sitter parse error detection (replaces brace counting)
    if let Some(lang) = lang {
        let errors = symbols::find_parse_errors(content, lang);
        for err in &errors {
            diagnostics.push(Diagnostic {
                line: err.line,
                severity: "error".to_string(),
                message: err.message.clone(),
            });
        }
    }

    diagnostics
}

// ============================================================================
// Helpers
// ============================================================================

use crate::utils::normalize_path;
