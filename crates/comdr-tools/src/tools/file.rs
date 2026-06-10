/// File tool implementations — read, write, edit, glob, grep, ls.
///
/// These are the most-used tools in any coding agent. Correctness is critical:
///   - `edit` must actually change the file (SDB Step 5 verifies this)
///   - `write` must be atomic where possible
///   - `grep` must handle large codebases efficiently
///   - `read` supports summary mode (symbol list) and selector mode (symbol extraction)

use std::sync::Arc;

use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};

/// Default max grep results returned.
const DEFAULT_MAX_RESULTS: usize = 250;
/// Default context lines for selector mode (±N lines around target).
const SELECTOR_CONTEXT_LINES: usize = 10;
use serde_json::Value;

/// Build and return all file-related tool instances.
pub fn register_all(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Arc::new(FileReadTool));
    registry.register(Arc::new(FileWriteTool));
    registry.register(Arc::new(FileEditTool));
    registry.register(Arc::new(FileDeleteTool));
    registry.register(Arc::new(FileGlobTool));
    registry.register(Arc::new(FileGrepTool));
    registry.register(Arc::new(FileLsTool));
}

// ============================================================================
// file_read
// ============================================================================

struct FileReadTool;

impl Tool for FileReadTool {
    fn name(&self) -> &str {
        "file_read"
    }

    fn description(&self) -> &str {
        "Read a file. Modes: 'full' (default, supports offset/limit), 'summary' (structured symbol list — functions, classes, imports), 'selector' (specific symbol definition with ±10 context lines). Use summary for large files to save context, selector to jump to a function/class."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to read"
                },
                "mode": {
                    "type": "string",
                    "description": "Read mode: 'full' (default), 'summary' (symbol list), 'selector' (specific symbol), 'blueprint' (AOCI-style structured overview: imports, exports, dependencies)",
                    "enum": ["full", "summary", "selector", "blueprint"],
                    "default": "full"
                },
                "symbol": {
                    "type": "string",
                    "description": "Symbol name for selector mode (e.g. 'loginHandler', 'AuthService')"
                },
                "offset": {
                    "type": "number",
                    "description": "Line number to start reading from (0-indexed, full mode)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum lines to read (full mode)"
                }
            },
            "required": ["path"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        5000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_write", "SCHEMA_INVALID", &[], None),
        };
        let path = normalize_path(path);
        let mode = args.get("mode").and_then(|v| v.as_str()).unwrap_or("full");

        match mode {
            "blueprint" => exec_blueprint(&path),
            "summary" => exec_summary(&path),
            "selector" => {
                let symbol = match args.get("symbol").and_then(|v| v.as_str()) {
                    Some(s) => s,
                    None => return ToolOutput::err("file_read", "SCHEMA_INVALID", &[], Some("selector mode requires symbol")),
                };
                exec_selector(&path, symbol)
            }
            _ => exec_full(&path, args), // "full" — existing behavior
        }
    }
}

// ============================================================================
// file_read helpers
// ============================================================================

/// Maximum in-memory file size for read operations (10 MB).
/// Files larger than this are rejected to prevent OOM.
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// Full-mode read — existing offset/limit behavior extracted into a free function.
fn exec_full(path: &str, args: &Value) -> ToolOutput {
    // ★ OOM 保护：大于 10MB 的文件拒绝全量读取
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_READ_SIZE {
            return ToolOutput::err("file_read", "FILE_TOO_LARGE",
                &[("path", path), ("size_bytes", &meta.len().to_string())],
                Some(&format!("File is {} MB — use offset/limit or summary mode", meta.len() / 1_048_576)),
            );
        }
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path)], Some(&e.to_string())),
    };

    let offset = args.get("offset").and_then(|v| v.as_f64()).map(|n| n as usize).unwrap_or(0);
    let limit = args.get("limit").and_then(|v| v.as_f64()).map(|n| n as usize);

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len();
    let start = offset.min(total_lines);
    let end = match limit {
        Some(lim) => (start + lim).min(total_lines),
        None => total_lines,
    };

    let output: String = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>6}\t{}", start + i + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    let range = format!("{}-{}/{}", start + 1, end, total_lines);
    ToolOutput::ok("file_read", &[("path", path), ("lines", &range)], Some(&output))
}

/// Summary mode — uses the same pattern-based extractors as bootstrap
/// to return a structured symbol list instead of full file content.
fn exec_summary(path: &str) -> ToolOutput {
    // ★ OOM 保护：大于 10MB 的文件拒绝 summary 模式
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_READ_SIZE {
            return ToolOutput::err("file_read", "FILE_TOO_LARGE",
                &[("path", path), ("size_bytes", &meta.len().to_string())],
                Some("File too large for summary mode"),
            );
        }
    }

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path)], Some(&e.to_string())),
    };

    let lang = match language_from_ext(path) {
        Some(l) => l,
        None => {
            let total = content.lines().count();
            let preview: String = content.lines().take(40).collect::<Vec<_>>().join("\n");
            return ToolOutput::ok("file_read", &[("path", path), ("mode", "summary"), ("lines", &total.to_string())], Some(&preview));
        }
    };
    let (symbols, references) = extract_symbols(path, &content, lang);
    let total_lines = content.lines().count();

    let mut out = format!("File: {} ({} lines, {} symbols)\n\n", path, total_lines, symbols.len());

    // ── Exports ──
    let exports: Vec<_> = symbols.iter().filter(|s| s.exported).collect();
    if !exports.is_empty() {
        out.push_str("## Exports\n");
        for s in &exports {
            let loc = s.location.as_ref().map(|l| format!(" @ {}", l)).unwrap_or_default();
            out.push_str(&format!("- {}() {}  {}{}\n",
                s.name, loc,
                if s.kind == "class" || s.kind == "interface" { format!("[{}] ", s.kind) } else { String::new() },
                if s.exported { "[exported]" } else { "" },
            ));
        }
        out.push('\n');
    }

    // ── Internal ──
    let internal: Vec<_> = symbols.iter().filter(|s| !s.exported).collect();
    if !internal.is_empty() {
        out.push_str("## Internal\n");
        for s in &internal {
            let loc = s.location.as_ref().map(|l| format!(" @ {}", l)).unwrap_or_default();
            out.push_str(&format!("- {}() {}{}\n", s.name, loc, s.kind));
        }
        out.push('\n');
    }

    // ── Imports ──
    if !references.is_empty() {
        out.push_str("## Imports\n");
        for r in &references {
            let target = r.to_file.as_deref().unwrap_or("(external)");
            out.push_str(&format!("- {} from '{}'\n", r.from_name, target));
        }
    }

    ToolOutput::ok("file_read", &[("path", path), ("mode", "summary")], Some(&out))
}

/// Selector mode — find a symbol by name and return its definition with context.
fn exec_selector(path: &str, symbol_name: &str) -> ToolOutput {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path)], Some(&e.to_string())),
    };

    let lang = match language_from_ext(path) {
        Some(l) => l,
        None => return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path)], Some("unsupported file type")),
    };

    let (symbols, _) = extract_symbols(path, &content, lang);
    let target = symbols.iter().find(|s| s.name == symbol_name);

    let line_num = match target.and_then(|s| s.location.as_ref()) {
        Some(loc) => {
            // location format: "path:line" → extract line number
            loc.split(':').last()
                .and_then(|n| n.parse::<usize>().ok())
                .unwrap_or(1)
        }
        None => {
            return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path), ("symbol", symbol_name)], Some("not found, use summary mode"));
        }
    };

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = if line_num > SELECTOR_CONTEXT_LINES { line_num - SELECTOR_CONTEXT_LINES - 1 } else { 0 };
    let end = (line_num + SELECTOR_CONTEXT_LINES).min(total);

    let output: String = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let current = start + i + 1;
            let marker = if current == line_num { ">>>" } else { "   " };
            format!("{} {:>5}\t{}", marker, current, line)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let _header = format!(
        "File: {} | Symbol: {}() @ line {} (lines {}-{} of {})\n\n",
        path, symbol_name, line_num, start + 1, end, total,
    );
    ToolOutput::ok("file_read", &[("path", path), ("mode", "selector"), ("symbol", symbol_name)], Some(&output))
}

// ============================================================================
// Blueprint mode — AOCI-style structured overview
// ============================================================================

/// Blueprint mode — returns a structured symbolic-semantic overview of a file.
/// Shows imports, exported API, internal symbols, and dependency relationships.
/// ~300 tokens for an 800-line file (vs ~6000 for full read).
fn exec_blueprint(path: &str) -> ToolOutput {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return ToolOutput::err("file_read", "EXECUTION_FAILED", &[("path", path)], Some(&e.to_string())),
    };

    let lang = match language_from_ext(path) {
        Some(l) => l,
        None => {
            // Unsupported → fall back to summary
            let total = content.lines().count();
            let preview: String = content.lines().take(30).collect::<Vec<_>>().join("\n");
            return ToolOutput::ok("file_read", &[("path", path), ("mode", "blueprint"), ("lines", &total.to_string())], Some(&preview));
        }
    };

    let (symbols, references) = extract_symbols(path, &content, lang);
    let total_lines = content.lines().count();
    let total = symbols.len();

    let mut out = format!("## Blueprint: {} ({} lines, {} symbols)\n", path, total_lines, total);

    // ── Imports (references from this file) ──
    let imports: Vec<&crate::tools::file::FileReference> = references.iter()
        .filter(|r| r.to_file.as_ref().map_or(false, |f| !f.starts_with("(external)")))
        .collect();
    if !imports.is_empty() {
        out.push_str("\n📦 Imports:\n");
        for r in &imports {
            let target = r.to_file.as_deref().unwrap_or("?");
            out.push_str(&format!("  - {} from {}\n", r.from_name, target));
        }
    }

    // ── Public API (exported) ──
    let exported: Vec<_> = symbols.iter().filter(|s| s.exported).collect();
    if !exported.is_empty() {
        out.push_str("\n📤 Public API:\n");
        for s in &exported {
            let loc = s.location.as_ref().map(|l| format!(" @{}", l.split(':').last().unwrap_or("?"))).unwrap_or_default();
            out.push_str(&format!("  - {}{}{}\n", s.name, kind_tag(&s.kind), loc));
        }
    }

    // ── Internals (non-exported) ──
    let internal: Vec<_> = symbols.iter().filter(|s| !s.exported && s.kind != "variable").collect();
    if !internal.is_empty() {
        out.push_str("\n🔒 Internals:\n");
        for s in &internal {
            let loc = s.location.as_ref().map(|l| format!(" @{}", l.split(':').last().unwrap_or("?"))).unwrap_or_default();
            out.push_str(&format!("  - {}{}{}\n", s.name, kind_tag(&s.kind), loc));
        }
    }

    // ── Variables ──
    let vars: Vec<_> = symbols.iter().filter(|s| s.kind == "variable").collect();
    if !vars.is_empty() {
        out.push_str("\n📌 Constants/Variables:\n");
        for v in vars.iter().take(5) {
            out.push_str(&format!("  - {}\n", v.name));
        }
    }

    // ── Dependencies (this file imports from) ──
    let project_refs: Vec<_> = references.iter()
        .filter(|r| r.to_file.as_ref().map_or(false, |f| f.starts_with('.') || f.starts_with('/') || f.contains('/')))
        .collect();
    if !project_refs.is_empty() {
        out.push_str("\n⬆️ Depends on:\n");
        for r in project_refs.iter().take(5) {
            out.push_str(&format!("  - {}\n", r.to_file.as_deref().unwrap_or("?")));
        }
    }

    ToolOutput::ok("file_read", &[("path", path), ("mode", "blueprint"), ("symbols", &total.to_string())], Some(&out))
}

fn kind_tag(kind: &str) -> &str {
    match kind {
        "function" => "()",
        "class" => " (class)",
        "interface" => " (interface)",
        "module" => " (module)",
        _ => "",
    }
}

// ============================================================================
// Symbol extraction helpers (reuse bootstrap.rs patterns)
// ============================================================================

/// Internal symbol struct — mirrors bootstrap::BootstrapSymbol but lives in this module.
struct FileSymbol {
    name: String,
    kind: String,
    location: Option<String>,
    exported: bool,
}

/// Internal reference struct.
struct FileReference {
    from_name: String,
    to_file: Option<String>,
}

/// Detect language from file extension (same logic as bootstrap.rs).
fn language_from_ext(path: &str) -> Option<&'static str> {
    if path.ends_with(".ts") || path.ends_with(".tsx") || path.ends_with(".js") || path.ends_with(".jsx") || path.ends_with(".mjs") {
        Some("typescript")
    } else if path.ends_with(".py") {
        Some("python")
    } else if path.ends_with(".rs") {
        Some("rust")
    } else {
        None
    }
}

/// Cached regex patterns for symbol extraction.
mod regex_cache {
    use regex::Regex;
    use std::sync::OnceLock;

    macro_rules! cached_regex {
        ($name:ident, $pattern:expr) => {
            pub fn $name() -> &'static Regex {
                static RE: OnceLock<Regex> = OnceLock::new();
                RE.get_or_init(|| Regex::new($pattern).unwrap())
            }
        };
    }

    cached_regex!(re_export_ts, r"export\s+(?:async\s+)?(?:function|class|interface|const|let|var|type|enum)\s+(\w+)");
    cached_regex!(re_func_ts, r"^(?:async\s+)?(?:function|class|interface)\s+(\w+)");
    cached_regex!(re_const_ts, r"^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=");
    cached_regex!(re_import_named_ts, r#"import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]"#);
    cached_regex!(re_import_default_ts, r#"import\s+(\w+)\s+from\s+['"]([^'"]+)['"]"#);
    cached_regex!(re_def_py, r"def\s+(\w+)\s*\(");
    cached_regex!(re_class_py, r"class\s+(\w+)\s*[:(]");
    cached_regex!(re_from_import_py, r"from\s+(\S+)\s+import\s+(.+)");
    cached_regex!(re_fn_rs, r"(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]");
    cached_regex!(re_struct_rs, r"(?:pub\s+)?struct\s+(\w+)");
    cached_regex!(re_enum_rs, r"(?:pub\s+)?enum\s+(\w+)");
    cached_regex!(re_trait_rs, r"(?:pub\s+)?trait\s+(\w+)");
}

/// Extract symbols and references from source using regex (same patterns as bootstrap.rs).
fn extract_symbols(path: &str, source: &str, lang: &str) -> (Vec<FileSymbol>, Vec<FileReference>) {
    let mut symbols = Vec::new();
    let mut references = Vec::new();
    let lines: Vec<&str> = source.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("#[") {
            continue;
        }
        let line_num = i + 1;
        let loc = Some(format!("{}:{}", path, line_num));

        match lang {
            "typescript" => {
                if let Some(caps) = regex_cache::re_export_ts().captures(trimmed) {
                    let kind = if trimmed.contains("function") || trimmed.contains("async") { "function" }
                        else if trimmed.contains("class") { "class" }
                        else if trimmed.contains("interface") { "interface" }
                        else if trimmed.contains("type") || trimmed.contains("enum") { "class" }
                        else { "variable" };
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: kind.to_string(), location: loc.clone(), exported: true });
                    continue;
                }
                if let Some(caps) = regex_cache::re_func_ts().captures(trimmed) {
                    let kind = if trimmed.contains("function") { "function" } else if trimmed.contains("class") { "class" } else { "interface" };
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: kind.to_string(), location: loc.clone(), exported: false });
                }
                if let Some(caps) = regex_cache::re_const_ts().captures(trimmed) {
                    let name = caps[1].to_string();
                    if !symbols.iter().any(|s: &FileSymbol| s.name == name) {
                        symbols.push(FileSymbol { name, kind: "variable".to_string(), location: loc.clone(), exported: trimmed.starts_with("export") });
                    }
                }
                if let Some(caps) = regex_cache::re_import_named_ts().captures(trimmed) {
                    for name in caps[1].split(',').map(|s| s.trim()) {
                        references.push(FileReference { from_name: name.to_string(), to_file: Some(caps[2].to_string()) });
                    }
                }
                if let Some(caps) = regex_cache::re_import_default_ts().captures(trimmed) {
                    references.push(FileReference { from_name: caps[1].to_string(), to_file: Some(caps[2].to_string()) });
                }
            }
            "python" => {
                if let Some(caps) = regex_cache::re_def_py().captures(trimmed) {
                    let name = caps[1].to_string();
                    if !name.starts_with('_') || name == "__init__" {
                        symbols.push(FileSymbol { name, kind: "function".to_string(), location: loc.clone(), exported: !trimmed.starts_with('_') });
                    }
                }
                if let Some(caps) = regex_cache::re_class_py().captures(trimmed) {
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: "class".to_string(), location: loc.clone(), exported: true });
                }
                if let Some(caps) = regex_cache::re_from_import_py().captures(trimmed) {
                    for name in caps[2].split(',').map(|s| s.split(" as ").next().unwrap_or(s).trim()) {
                        references.push(FileReference { from_name: name.to_string(), to_file: Some(caps[1].to_string()) });
                    }
                }
            }
            "rust" => {
                if let Some(caps) = regex_cache::re_fn_rs().captures(trimmed) {
                    let is_pub = trimmed.contains("pub ");
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: "function".to_string(), location: loc.clone(), exported: is_pub });
                }
                if let Some(caps) = regex_cache::re_struct_rs().captures(trimmed) {
                    let is_pub = trimmed.contains("pub ");
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: "class".to_string(), location: loc.clone(), exported: is_pub });
                }
                if let Some(caps) = regex_cache::re_enum_rs().captures(trimmed) {
                    let is_pub = trimmed.contains("pub ");
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: "class".to_string(), location: loc.clone(), exported: is_pub });
                }
                if let Some(caps) = regex_cache::re_trait_rs().captures(trimmed) {
                    symbols.push(FileSymbol { name: caps[1].to_string(), kind: "interface".to_string(), location: loc.clone(), exported: true });
                }
            }
            _ => {}
        }
    }

    (symbols, references)
}

// ============================================================================
// file_write
// ============================================================================

struct FileWriteTool;

impl Tool for FileWriteTool {
    fn name(&self) -> &str {
        "file_write"
    }

    fn description(&self) -> &str {
        "Write content to a file, creating it if it doesn't exist. Overwrites existing files."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["path", "content"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_write", "SCHEMA_INVALID", &[], None),
        };
        let content = match args.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolOutput::err("file_write", "SCHEMA_INVALID", &[], None),
        };

        let path = normalize_path(path);

        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(&path).parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutput::err("file_write", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string()));
            }
        }

        // ★ 原子写入：先写临时文件，再 rename 到目标。
        //   避免崩溃或磁盘满时留下半截文件（直接 std::fs::write 会覆盖原文件）。
        let tmp_path = format!("{}.comdr-tmp-{}", path, std::process::id());
        match std::fs::write(&tmp_path, content) {
            Ok(()) => match std::fs::rename(&tmp_path, &path) {
                Ok(()) => ToolOutput::ok("file_write", &[("path", &path), ("bytes", &content.len().to_string())], None),
                Err(e) => {
                    // Best-effort: clean up temp file after failed rename.
                    if let Err(rm_err) = std::fs::remove_file(&tmp_path) {
                        eprintln!("[file_write] failed to clean up temp file {}: {}", tmp_path, rm_err);
                    }
                    ToolOutput::err("file_write", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string()))
                }
            },
            Err(e) => {
                // Best-effort: clean up temp file after failed write.
                if let Err(rm_err) = std::fs::remove_file(&tmp_path) {
                    eprintln!("[file_write] failed to clean up temp file {}: {}", tmp_path, rm_err);
                }
                ToolOutput::err("file_write", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string()))
            }
        }
    }
}

// ============================================================================
// file_edit
// ============================================================================

struct FileEditTool;

impl Tool for FileEditTool {
    fn name(&self) -> &str {
        "file_edit"
    }

    fn description(&self) -> &str {
        "Replace a string in a file. old_string must match exactly once."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to edit"
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact string to replace"
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement string"
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace all occurrences (default: false)",
                    "default": false
                }
            },
            "required": ["path", "old_string", "new_string"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_write", "SCHEMA_INVALID", &[], None),
        };
        let old_string = match args.get("old_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolOutput::err("file_edit", "SCHEMA_INVALID", &[], None),
        };
        let new_string = match args.get("new_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolOutput::err("file_edit", "SCHEMA_INVALID", &[], None),
        };
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let path = normalize_path(path);

        let original = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::err("file_edit", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string()))
            }
        };

        if old_string.is_empty() {
            return ToolOutput::err("file_edit", "SCHEMA_INVALID", &[], None);
        }

        let occurrences = original.matches(old_string).count();

        if occurrences == 0 {
            return ToolOutput::err("file_edit", "EXECUTION_FAILED", &[("path", &path)], Some("old_string not found"));
        }

        if !replace_all && occurrences > 1 {
            return ToolOutput::err("file_edit", "EXECUTION_FAILED", &[("path", &path), ("occurrences", &occurrences.to_string())], Some("use replace_all or make old_string more specific"));
        }

        let modified = if replace_all {
            original.replace(old_string, new_string)
        } else {
            original.replacen(old_string, new_string, 1)
        };

        match std::fs::write(&path, &modified) {
            Ok(()) => {
                let replaced_count = if replace_all { occurrences } else { 1 };
                ToolOutput::ok("file_edit", &[("path", &path), ("replaced", &replaced_count.to_string())], None)
            }
            Err(e) => ToolOutput::err("file_edit", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string())),
        }
    }
}

// ============================================================================
// file_delete
// ============================================================================

struct FileDeleteTool;

impl Tool for FileDeleteTool {
    fn name(&self) -> &str {
        "file_delete"
    }

    fn description(&self) -> &str {
        "Delete a file at the specified path."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to delete"
                }
            },
            "required": ["path"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        5000
    }

    fn execute(&self, args: &Value, _ctx: &ToolContext) -> ToolOutput {
        let path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_write", "SCHEMA_INVALID", &[], None),
        };

        let path = normalize_path(path);

        match std::fs::remove_file(&path) {
            Ok(()) => ToolOutput::ok("file_delete", &[("path", &path)], None),
            Err(e) => ToolOutput::err("file_delete", "EXECUTION_FAILED", &[("path", &path)], Some(&e.to_string())),
        }
    }
}

// ============================================================================
// file_glob
// ============================================================================

struct FileGlobTool;

impl Tool for FileGlobTool {
    fn name(&self) -> &str {
        "file_glob"
    }

    fn description(&self) -> &str {
        "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/*.rs')."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (supports **, *, ?, [...])"
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (defaults to project root)"
                }
            },
            "required": ["pattern"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        15000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_glob", "SCHEMA_INVALID", &[], None),
        };

        let base_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ctx.project_path.clone());

        let base_path = normalize_path(&base_path);

        use std::path::Path;

        let full_pattern = Path::new(&base_path).join(pattern.trim_start_matches('/'))
            .to_string_lossy()
            .replace('\\', "/");

        let results: Vec<String> = match glob::glob(&full_pattern) {
            Ok(paths) => paths
                .filter_map(|entry| entry.ok())
                .map(|p| normalize_path(&p.to_string_lossy()))
                .collect(),
            Err(e) => {
                return ToolOutput::err("file_glob", "EXECUTION_FAILED", &[], Some(&e.to_string()))
            }
        };

        if results.is_empty() {
            ToolOutput::ok("file_glob", &[("matched", "0")], None)
        } else {
            ToolOutput::ok("file_glob", &[("matched", &results.len().to_string())], Some(&results.join("\n")))
        }
    }
}

// ============================================================================
// file_grep
// ============================================================================

struct FileGrepTool;

impl Tool for FileGrepTool {
    fn name(&self) -> &str {
        "file_grep"
    }

    fn description(&self) -> &str {
        "Search for a regex pattern in files. Returns matching lines with file paths and line numbers."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regular expression pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "File or directory to search in (defaults to project root)"
                },
                "glob": {
                    "type": "string",
                    "description": "Filter files by glob pattern (e.g. '*.rs', '*.ts')"
                },
                "max_results": {
                    "type": "number",
                    "description": "Maximum number of matching lines to return (default: 250)"
                }
            },
            "required": ["pattern"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        30000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return ToolOutput::err("file_glob", "SCHEMA_INVALID", &[], None),
        };

        let regex = match regex::Regex::new(pattern) {
            Ok(r) => r,
            Err(e) => {
                return ToolOutput::err("file_grep", "SCHEMA_INVALID", &[], Some(&e.to_string()))
            }
        };

        let search_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ctx.project_path.clone());

        let search_path = normalize_path(&search_path);
        let file_glob = args.get("glob").and_then(|v| v.as_str()).map(|s| s.to_string());
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_f64())
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_MAX_RESULTS);

        let mut results: Vec<String> = Vec::new();
        let search_root = std::path::Path::new(&search_path);

        // Determine which files to search
        let files: Vec<std::path::PathBuf> = if search_root.is_file() {
            vec![search_root.to_path_buf()]
        } else if search_root.is_dir() {
            walkdir::WalkDir::new(search_root)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter(|e| {
                    if let Some(ref g) = file_glob {
                        let path_str = e.path().to_string_lossy();
                        let normalized = normalize_path(&path_str);
                        glob_match(g, &normalized)
                    } else {
                        true
                    }
                })
                .map(|e| e.path().to_path_buf())
                .collect()
        } else {
            return ToolOutput::err("file_grep", "EXECUTION_FAILED", &[("path", &search_path)], Some("path not found"));
        };

        'outer: for file_path in files {
            if results.len() >= max_results {
                break;
            }

            let content = match std::fs::read_to_string(&file_path) {
                Ok(c) => c,
                Err(_) => continue, // Skip unreadable files (binary, permission denied, etc.)
            };

            // Quick check: does the regex match anywhere in the file?
            if !regex.is_match(&content) {
                continue;
            }

            for (line_num, line) in content.lines().enumerate() {
                if results.len() >= max_results {
                    break 'outer;
                }
                if regex.is_match(line) {
                    let display_path = normalize_path(&file_path.to_string_lossy());
                    results.push(format!("{}:{}: {}", display_path, line_num + 1, line));
                }
            }
        }

        if results.is_empty() {
            ToolOutput::ok("file_grep", &[("matched", "0")], None)
        } else {
            let summary = format!("Found {} match(es):\n\n{}", results.len(), results.join("\n"));
            ToolOutput::ok("file_grep", &[("matched", &results.len().to_string())], Some(&summary))
        }
    }
}

// ============================================================================
// file_ls
// ============================================================================

struct FileLsTool;

impl Tool for FileLsTool {
    fn name(&self) -> &str {
        "file_ls"
    }

    fn description(&self) -> &str {
        "List files and directories at the given path."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list (defaults to project root)"
                }
            },
            "required": []
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        5000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let dir_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ctx.project_path.clone());

        let dir_path = normalize_path(&dir_path);

        let entries = match std::fs::read_dir(&dir_path) {
            Ok(rd) => rd,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot list '{}': {}", dir_path, e),
                )
            }
        };

        let mut listing = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type().map(|ft| {
                if ft.is_dir() {
                    "dir"
                } else if ft.is_symlink() {
                    "symlink"
                } else {
                    "file"
                }
            }).unwrap_or("unknown");

            let size = entry.metadata()
                .map(|m| m.len())
                .unwrap_or(0);

            listing.push(format!("{:>10}  {:<8}  {}", size, file_type, name));
        }

        // Sort: dirs first, then files, alphabetical within each group
        listing.sort_by(|a, b| {
            let a_is_dir = a.contains("  dir      ");
            let b_is_dir = b.contains("  dir      ");
            b_is_dir.cmp(&a_is_dir).then_with(|| a.cmp(b))
        });

        if listing.is_empty() {
            ToolOutput::ok("file_ls", &[("path", &dir_path), ("entries", "0")], None)
        } else {
            let _header = format!("Listing '{}' ({} entries):\n\n", dir_path, listing.len());
            ToolOutput::ok("file_ls", &[("path", &dir_path), ("entries", &listing.len().to_string())], Some(&listing.join("\n")))
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

use crate::utils::normalize_path;

/// Simple glob matching for file filtering in grep.
/// Supports * and ** (but not full glob syntax — just for filename filtering).
fn glob_match(glob: &str, path: &str) -> bool {
    let glob = normalize_path(glob);
    let path = normalize_path(path);

    // If glob doesn't contain path separators, match against the filename only
    if !glob.contains('/') {
        let filename = std::path::Path::new(&path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        return simple_match(&glob, &filename);
    }

    simple_match(&glob, &path)
}

fn simple_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split("**").collect();
    if parts.len() == 1 {
        // No ** — use simple wildcard matching
        return wildcard_match(pattern, text);
    }

    // Contains ** — match each segment in order
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        let part = part.trim_start_matches('/');
        if part.is_empty() {
            continue;
        }
        if i == parts.len() - 1 {
            // Last segment: match against the end
            return wildcard_match_suffix(part, rest);
        }
        // Find this segment in the remaining text
        if let Some(pos) = find_wildcard(part, rest) {
            rest = &rest[pos..];
        } else {
            return false;
        }
    }
    true
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern_bytes = pattern.as_bytes();
    let text_bytes = text.as_bytes();
    let p_len = pattern_bytes.len();
    let t_len = text_bytes.len();

    // DP table: dp[i][j] = pattern[..i] matches text[..j]
    let mut dp = vec![vec![false; t_len + 1]; p_len + 1];
    dp[0][0] = true;

    // Handle leading * in pattern
    for i in 0..p_len {
        if pattern_bytes[i] == b'*' {
            dp[i + 1][0] = dp[i][0];
        } else {
            break;
        }
    }

    for i in 0..p_len {
        for j in 0..t_len {
            if pattern_bytes[i] == b'*' {
                dp[i + 1][j + 1] = dp[i][j + 1] || dp[i + 1][j];
            } else if pattern_bytes[i] == b'?' || pattern_bytes[i] == text_bytes[j] {
                dp[i + 1][j + 1] = dp[i][j];
            }
        }
    }

    dp[p_len][t_len]
}

fn wildcard_match_suffix(pattern: &str, text: &str) -> bool {
    // Match pattern against a suffix of text
    for start in 0..=text.len() {
        if wildcard_match(pattern, &text[start..]) {
            return true;
        }
    }
    false
}

fn find_wildcard(pattern: &str, text: &str) -> Option<usize> {
    // Find first position where pattern matches a prefix of text[pos..]
    for pos in 0..text.len() {
        if wildcard_match_prefix(pattern, &text[pos..]) {
            return Some(pos + 1);
        }
    }
    None
}

fn wildcard_match_prefix(pattern: &str, text: &str) -> bool {
    let pattern_bytes = pattern.as_bytes();
    let text_bytes = text.as_bytes();
    let p_len = pattern_bytes.len();
    let t_len = text_bytes.len();

    let mut dp = vec![vec![false; t_len + 1]; p_len + 1];
    dp[0][0] = true;

    for i in 0..p_len {
        if pattern_bytes[i] == b'*' {
            dp[i + 1][0] = dp[i][0];
        } else {
            break;
        }
    }

    for i in 0..p_len {
        for j in 0..t_len {
            if pattern_bytes[i] == b'*' {
                dp[i + 1][j + 1] = dp[i][j + 1] || dp[i + 1][j];
            } else if pattern_bytes[i] == b'?' || pattern_bytes[i] == text_bytes[j] {
                dp[i + 1][j + 1] = dp[i][j];
            }
        }
    }

    dp[p_len][t_len]
}
