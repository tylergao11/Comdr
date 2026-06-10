/// bootstrap.rs — pattern-based project symbol extractor.
///
/// Scans project source files and extracts symbols (functions, classes, imports)
/// without LLM or tree-sitter dependencies. Pure regex-based parsing covers
/// TypeScript/JavaScript, Python, and Rust — ~90% accuracy for symbol discovery.
///
/// Used by Engine at session start to populate Semantic Memory's four graphs.
/// Zero external dependencies beyond std + regex.

use regex::Regex;
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
// TypeScript/JavaScript extractor
// ============================================================================

fn extract_typescript(file_path: &str, source: &str) -> (Vec<BootstrapSymbol>, Vec<BootstrapReference>) {
    // ★ Regex compiled once, cached in OnceLock
    static RE_EXPORT: OnceLock<Regex> = OnceLock::new();
    static RE_FUNC: OnceLock<Regex> = OnceLock::new();
    static RE_CONST: OnceLock<Regex> = OnceLock::new();
    static RE_IMPORT_NAMED: OnceLock<Regex> = OnceLock::new();
    static RE_IMPORT_DEFAULT: OnceLock<Regex> = OnceLock::new();

    let re_export = RE_EXPORT.get_or_init(|| Regex::new(r"export\s+(?:async\s+)?(?:function|class|interface|const|let|var|type|enum)\s+(\w+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_func = RE_FUNC.get_or_init(|| Regex::new(r"^(?:async\s+)?(?:function|class|interface)\s+(\w+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_const = RE_CONST.get_or_init(|| Regex::new(r"^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=").unwrap()); // static pattern — panic on invalid regex is correct
    let re_import_named = RE_IMPORT_NAMED.get_or_init(|| Regex::new(r#"import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]"#).unwrap()); // static pattern — panic on invalid regex is correct
    let re_import_default = RE_IMPORT_DEFAULT.get_or_init(|| Regex::new(r#"import\s+(\w+)\s+from\s+['"]([^'"]+)['"]"#).unwrap()); // static pattern — panic on invalid regex is correct

    let mut symbols = Vec::new();
    let mut references = Vec::new();

    let lines: Vec<&str> = source.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") { continue; }

        let line_num = i + 1;
        let loc = Some(format!("{}:{}", file_path, line_num));

        // export function/class/const/interface
        if let Some(caps) = re_export.captures(trimmed) {
            let name = caps[1].to_string();
            let kind = if trimmed.contains("function") || trimmed.contains("async") { "function" }
                else if trimmed.contains("class") { "class" }
                else if trimmed.contains("interface") { "interface" }
                else if trimmed.contains("type") { "interface" }
                else if trimmed.contains("enum") { "class" }
                else { "variable" };
            symbols.push(BootstrapSymbol { name, kind: kind.to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: true });
            continue;
        }

        // Regular function/class/interface (non-exported)
        if let Some(caps) = re_func.captures(trimmed) {
            let name = caps[1].to_string();
            let kind = if trimmed.contains("function") { "function" }
                else if trimmed.contains("class") { "class" }
                else { "interface" };
            symbols.push(BootstrapSymbol { name, kind: kind.to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: false });
        }

        // const/let/var declarations (top-level exports only, non-function/class)
        if let Some(caps) = re_const.captures(trimmed) {
            let name = caps[1].to_string();
            if !symbols.iter().any(|s| s.name == name && s.file_path == file_path) {
                symbols.push(BootstrapSymbol { name, kind: "variable".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: trimmed.starts_with("export") });
            }
        }

        // import { X } from 'Y' → reference
        if let Some(caps) = re_import_named.captures(trimmed) {
            let names: Vec<&str> = caps[1].split(',').map(|s| s.trim()).collect();
            let from_path = caps[2].to_string();
            let is_relative = from_path.starts_with('.');
            for name in names {
                references.push(BootstrapReference {
                    from_name: name.to_string(),
                    from_file: file_path.to_string(),
                    to_name: name.to_string(),
                    to_file: if is_relative { Some(from_path.clone()) } else { None },
                    ref_type: "imports".to_string(),
                });
            }
        }

        // import X from 'Y' → reference
        if let Some(caps) = re_import_default.captures(trimmed) {
            let name = caps[1].to_string();
            let from_path = caps[2].to_string();
            let is_relative = from_path.starts_with('.');
            references.push(BootstrapReference {
                from_name: name.clone(),
                from_file: file_path.to_string(),
                to_name: name,
                to_file: if is_relative { Some(from_path) } else { None },
                ref_type: "imports".to_string(),
            });
        }
    }

    (symbols, references)
}

// ============================================================================
// Python extractor
// ============================================================================

fn extract_python(file_path: &str, source: &str) -> (Vec<BootstrapSymbol>, Vec<BootstrapReference>) {
    static RE_DEF: OnceLock<Regex> = OnceLock::new();
    static RE_CLASS: OnceLock<Regex> = OnceLock::new();
    static RE_FROM_IMPORT: OnceLock<Regex> = OnceLock::new();
    static RE_IMPORT: OnceLock<Regex> = OnceLock::new();

    let re_def = RE_DEF.get_or_init(|| Regex::new(r"def\s+(\w+)\s*\(").unwrap()); // static pattern — panic on invalid regex is correct
    let re_class = RE_CLASS.get_or_init(|| Regex::new(r"class\s+(\w+)\s*[:(]").unwrap()); // static pattern — panic on invalid regex is correct
    let re_from_import = RE_FROM_IMPORT.get_or_init(|| Regex::new(r"from\s+(\S+)\s+import\s+(.+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_import = RE_IMPORT.get_or_init(|| Regex::new(r"^import\s+(\S+)").unwrap()); // static pattern — panic on invalid regex is correct

    let mut symbols = Vec::new();
    let mut references = Vec::new();

    let lines: Vec<&str> = source.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }

        let line_num = i + 1;
        let loc = Some(format!("{}:{}", file_path, line_num));

        if let Some(caps) = re_def.captures(trimmed) {
            let name = caps[1].to_string();
            if !name.starts_with('_') || name == "__init__" {
                symbols.push(BootstrapSymbol { name, kind: "function".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: !trimmed.starts_with('_') });
            }
        }

        if let Some(caps) = re_class.captures(trimmed) {
            let name = caps[1].to_string();
            symbols.push(BootstrapSymbol { name, kind: "class".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: true });
        }

        if let Some(caps) = re_from_import.captures(trimmed) {
            let from_mod = caps[1].to_string();
            let imported = caps[2].to_string();
            let is_relative = from_mod.starts_with('.');
            for name in imported.split(',').map(|s| s.trim()) {
                let clean = name.split(" as ").next().unwrap_or(name).trim();
                if !clean.is_empty() {
                    references.push(BootstrapReference {
                        from_name: clean.to_string(),
                        from_file: file_path.to_string(),
                        to_name: clean.to_string(),
                        to_file: if is_relative { Some(from_mod.clone()) } else { None },
                        ref_type: "imports".to_string(),
                    });
                }
            }
        }

        if let Some(caps) = re_import.captures(trimmed) {
            let mod_name = caps[1].to_string();
            references.push(BootstrapReference {
                from_name: mod_name.clone(),
                from_file: file_path.to_string(),
                to_name: mod_name,
                to_file: None,
                ref_type: "imports".to_string(),
            });
        }
    }

    (symbols, references)
}

// ============================================================================
// Rust extractor
// ============================================================================

fn extract_rust(file_path: &str, source: &str) -> (Vec<BootstrapSymbol>, Vec<BootstrapReference>) {
    static RE_FN: OnceLock<Regex> = OnceLock::new();
    static RE_STRUCT: OnceLock<Regex> = OnceLock::new();
    static RE_ENUM: OnceLock<Regex> = OnceLock::new();
    static RE_TRAIT: OnceLock<Regex> = OnceLock::new();
    static RE_USE: OnceLock<Regex> = OnceLock::new();

    let re_fn = RE_FN.get_or_init(|| Regex::new(r"(?:pub(?:\s*\(\s*crate\s*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<\(]").unwrap()); // static pattern — panic on invalid regex is correct
    let re_struct = RE_STRUCT.get_or_init(|| Regex::new(r"(?:pub\s+)?struct\s+(\w+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_enum = RE_ENUM.get_or_init(|| Regex::new(r"(?:pub\s+)?enum\s+(\w+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_trait = RE_TRAIT.get_or_init(|| Regex::new(r"(?:pub\s+)?trait\s+(\w+)").unwrap()); // static pattern — panic on invalid regex is correct
    let re_use = RE_USE.get_or_init(|| Regex::new(r"use\s+(crate::\S+)").unwrap()); // static pattern — panic on invalid regex is correct

    let mut symbols = Vec::new();
    let mut references = Vec::new();

    let lines: Vec<&str> = source.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("#[") || trimmed.starts_with("///") { continue; }

        let line_num = i + 1;
        let loc = Some(format!("{}:{}", file_path, line_num));

        if let Some(caps) = re_fn.captures(trimmed) {
            let name = caps[1].to_string();
            let is_pub = trimmed.contains("pub ");
            symbols.push(BootstrapSymbol { name, kind: "function".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: is_pub });
        }

        if let Some(caps) = re_struct.captures(trimmed) {
            let name = caps[1].to_string();
            let is_pub = trimmed.contains("pub ");
            symbols.push(BootstrapSymbol { name, kind: "class".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: is_pub });
        }

        if let Some(caps) = re_enum.captures(trimmed) {
            let name = caps[1].to_string();
            let is_pub = trimmed.contains("pub ");
            symbols.push(BootstrapSymbol { name, kind: "class".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: is_pub });
        }

        if let Some(caps) = re_trait.captures(trimmed) {
            let name = caps[1].to_string();
            symbols.push(BootstrapSymbol { name, kind: "interface".to_string(), file_path: file_path.to_string(), location: loc.clone(), exported: true });
        }

        if let Some(caps) = re_use.captures(trimmed) {
            let path = caps[1].to_string();
            let last_seg = path.split("::").last().unwrap_or(&path).to_string();
            references.push(BootstrapReference {
                from_name: last_seg.clone(),
                from_file: file_path.to_string(),
                to_name: last_seg,
                to_file: Some(path),
                ref_type: "imports".to_string(),
            });
        }
    }

    (symbols, references)
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
            if !should_skip_dir(&name) {
                scan_dir(root, &path, symbols, references, files_scanned)?;
            }
            continue;
        }

        if should_skip_file(&path) { continue; }

        let lang = match language_from_ext(&name) {
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

        let (file_symbols, file_refs) = match lang {
            "typescript" => extract_typescript(&rel_path, &source),
            "python" => extract_python(&rel_path, &source),
            "rust" => extract_rust(&rel_path, &source),
            _ => continue,
        };

        symbols.extend(file_symbols);
        references.extend(file_refs);
        files_scanned.push(rel_path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_typescript_function() {
        let src = "export async function helloWorld(arg: string) {\n  return arg;\n}";
        let (syms, _) = extract_typescript("test.ts", src);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "helloWorld");
        assert_eq!(syms[0].kind, "function");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_extract_typescript_import() {
        let src = "import { readFile, writeFile } from 'node:fs';";
        let (_, refs) = extract_typescript("test.ts", src);
        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].from_name, "readFile");
    }

    #[test]
    fn test_extract_python_def() {
        let src = "def login_handler(request):\n    return request";
        let (syms, _) = extract_python("test.py", src);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "login_handler");
    }

    #[test]
    fn test_extract_rust_fn() {
        let src = "pub fn execute(opts: JsExecuteOptions) -> JsExecuteResult {";
        let (syms, _) = extract_rust("test.rs", src);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "execute");
        assert!(syms[0].exported);
    }
}
