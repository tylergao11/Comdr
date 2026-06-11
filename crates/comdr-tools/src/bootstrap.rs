/// bootstrap.rs — project symbol extractor.
///
/// Scans project source files and extracts symbols (functions, classes, imports)
/// using tree-sitter AST parsing.
/// Supports TypeScript/JavaScript, Python, and Rust.
///
/// Used by Engine at session start to populate Semantic Memory's four graphs.

use crate::symbols::{self};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapSymbol {
    pub name: String,
    pub kind: String, // "function" | "class" | "interface" | "module" | "variable"
    pub file_path: String,
    pub location: Option<String>, // "file:line"
    pub exported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapReference {
    pub from_name: String,
    pub from_file: String,
    pub to_name: String,
    pub to_file: Option<String>, // None if external module
    pub ref_type: String,        // "imports" | "calls"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapReport {
    pub symbols: Vec<BootstrapSymbol>,
    pub references: Vec<BootstrapReference>,
    pub files_scanned: Vec<String>,
}

// ============================================================================
// Language detectors + extractors
// ============================================================================


fn ignore_patterns() -> &'static HashSet<&'static str> {
    static IGNORE: OnceLock<HashSet<&'static str>> = OnceLock::new();
    IGNORE.get_or_init(|| {
        HashSet::from([
            "node_modules", ".git", "dist", "build", "target",
            "__pycache__", ".venv", "venv", ".next", ".turbo",
            "coverage", ".nyc_output",
        ])
    })
}

fn should_skip_dir(name: &str) -> bool {
    ignore_patterns().contains(name) || name.starts_with('.')
}

fn should_skip_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.ends_with(".d.ts") || name.ends_with(".min.js") || name.ends_with(".generated.ts")
}

// ============================================================================
// Kind mapping: tree-sitter → bootstrap
// ============================================================================

/// Map tree-sitter's richer kind vocabulary to bootstrap's simpler set.
fn normalize_kind(ts_kind: &str) -> &str {
    match ts_kind {
        "function" | "method" => "function",
        "class" | "struct" | "enum" => "class",
        "interface" | "trait" | "type" => "interface",
        "impl" | "module" => "module",
        "variable" | "constant" => "variable",
        _ => "variable",
    }
}

// ============================================================================
// Main entry: scan project directory
// ============================================================================

pub fn scan_project(project_path: &str) -> BootstrapReport {
    let root = Path::new(project_path);
    let mut symbols = Vec::new();
    let mut references = Vec::new();
    let mut files_scanned = Vec::new();

    if let Err(e) = scan_dir(root, root, &mut symbols, &mut references, &mut files_scanned) {
        eprintln!("[bootstrap] scan error: {}", e);
    }

    BootstrapReport {
        symbols,
        references,
        files_scanned,
    }
}

fn scan_dir(
    root: &Path,
    dir: &Path,
    symbols: &mut Vec<BootstrapSymbol>,
    references: &mut Vec<BootstrapReference>,
    files_scanned: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    if !dir.is_dir() { return Ok(()); }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            // ★ 跳过 symlink 目录防止扫描项目外文件
            if path.is_symlink() { continue; }
            if !should_skip_dir(&name) {
                scan_dir(root, &path, symbols, references, files_scanned)?;
            }
            continue;
        }

        if should_skip_file(&path) { continue; }

        let lang = match symbols::language_from_ext(&name) {
            Some(l) => l,
            None => continue,
        };

        let rel_path = path.strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let source = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let (extracted_syms, extracted_refs) = symbols::extract(&source, lang);

        let file_symbols: Vec<BootstrapSymbol> = extracted_syms
            .into_iter()
            .map(|s| BootstrapSymbol {
                name: s.name,
                kind: normalize_kind(&s.kind).to_string(),
                file_path: rel_path.clone(),
                location: Some(format!("{}:{}", rel_path, s.line + 1)),
                exported: s.exported,
            })
            .collect();

        let file_refs: Vec<BootstrapReference> = extracted_refs
            .into_iter()
            .map(|r| BootstrapReference {
                from_name: r.name.clone(),
                from_file: rel_path.clone(),
                to_name: r.name,
                to_file: if r.is_relative {
                    Some(r.source)
                } else {
                    None
                },
                ref_type: "imports".to_string(),
            })
            .collect();

        symbols.extend(file_symbols);
        references.extend(file_refs);
        files_scanned.push(rel_path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_bootstrap(
        rel_path: &str,
        syms: Vec<symbols::ExtractedSymbol>,
        refs: Vec<symbols::ExtractedReference>,
    ) -> (Vec<BootstrapSymbol>, Vec<BootstrapReference>) {
        let bs: Vec<_> = syms
            .into_iter()
            .map(|s| BootstrapSymbol {
                name: s.name,
                kind: normalize_kind(&s.kind).to_string(),
                file_path: rel_path.to_string(),
                location: Some(format!("{}:{}", rel_path, s.line + 1)),
                exported: s.exported,
            })
            .collect();
        let br: Vec<_> = refs
            .into_iter()
            .map(|r| BootstrapReference {
                from_name: r.name.clone(),
                from_file: rel_path.to_string(),
                to_name: r.name,
                to_file: if r.is_relative {
                    Some(r.source)
                } else {
                    None
                },
                ref_type: "imports".to_string(),
            })
            .collect();
        (bs, br)
    }

    #[test]
    fn test_extract_typescript_function() {
        let src = "export async function helloWorld(arg: string) {\n  return arg;\n}";
        let (syms, refs) = symbols::extract(src, symbols::SourceLanguage::TypeScript);
        let (syms, _) = to_bootstrap("test.ts", syms, refs);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "helloWorld");
        assert_eq!(syms[0].kind, "function");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_extract_typescript_import() {
        let src = "import { readFile, writeFile } from 'node:fs';";
        let (syms, refs) = symbols::extract(src, symbols::SourceLanguage::TypeScript);
        let (_, refs) = to_bootstrap("test.ts", syms, refs);
        assert!(refs.len() >= 1);
        let names: Vec<_> = refs.iter().map(|r| r.from_name.as_str()).collect();
        assert!(names.contains(&"readFile"));
    }

    #[test]
    fn test_extract_python_def() {
        let src = "def login_handler(request):\n    return request";
        let (syms, refs) = symbols::extract(src, symbols::SourceLanguage::Python);
        let (syms, _) = to_bootstrap("test.py", syms, refs);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "login_handler");
    }

    #[test]
    fn test_extract_rust_fn() {
        let src = "pub fn execute(opts: JsExecuteOptions) -> JsExecuteResult {\n    todo!()\n}";
        let (syms, refs) = symbols::extract(src, symbols::SourceLanguage::Rust);
        let (syms, _) = to_bootstrap("test.rs", syms, refs);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "execute");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_normalize_kind_mapping() {
        assert_eq!(normalize_kind("function"), "function");
        assert_eq!(normalize_kind("method"), "function");
        assert_eq!(normalize_kind("class"), "class");
        assert_eq!(normalize_kind("struct"), "class");
        assert_eq!(normalize_kind("enum"), "class");
        assert_eq!(normalize_kind("interface"), "interface");
        assert_eq!(normalize_kind("trait"), "interface");
        assert_eq!(normalize_kind("type"), "interface");
        assert_eq!(normalize_kind("impl"), "module");
        assert_eq!(normalize_kind("module"), "module");
        assert_eq!(normalize_kind("variable"), "variable");
        assert_eq!(normalize_kind("constant"), "variable");
    }
}
