/// symbols.rs — Tree-sitter AST symbol extraction.
///
/// Replaces the regex-based symbol extraction that was duplicated across
/// bootstrap.rs, tools/file.rs, and tools/lsp.rs with a single shared
/// tree-sitter-based module.
///
/// Supported languages: TypeScript/JavaScript, Python, Rust.
/// Parser and Query instances are cached globally via OnceLock<Mutex<…>>.

use std::sync::{Mutex, OnceLock};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

// ============================================================================
// Data types
// ============================================================================

/// Language enum for dispatching to the correct parser / queries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLanguage {
    TypeScript,
    Python,
    Rust,
}

/// A single extracted symbol (function, class, variable, etc.).
#[derive(Debug, Clone)]
pub struct ExtractedSymbol {
    pub name: String,
    /// "function" | "class" | "interface" | "struct" | "enum" | "trait" |
    /// "impl" | "module" | "type" | "variable" | "constant" | "method"
    pub kind: String,
    /// 0-indexed line number of the definition start.
    pub line: usize,
    /// 0-indexed column of the definition start.
    pub column: usize,
    /// 0-indexed end line.
    pub end_line: usize,
    /// 0-indexed end column.
    pub end_column: usize,
    /// Whether the symbol is exported / publicly visible.
    pub exported: bool,
    /// Parent scope names, innermost first.
    /// e.g. a method `bar()` inside `class Foo` has scope `["Foo"]`.
    pub scope: Vec<String>,
}

/// A reference (import / use) extracted from source.
#[derive(Debug, Clone)]
pub struct ExtractedReference {
    pub name: String,
    /// Module path or file reference.
    pub source: String,
    /// Whether the source looks like a relative path.
    pub is_relative: bool,
}

/// A parse error detected by tree-sitter (ERROR or MISSING nodes).
#[derive(Debug, Clone)]
pub struct ParseError {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

// ============================================================================
// Language detection (shared, replaces 3 duplicated functions)
// ============================================================================

/// Detect source language from a file extension.
pub fn language_from_ext(path: &str) -> Option<SourceLanguage> {
    if path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".mjs")
    {
        Some(SourceLanguage::TypeScript)
    } else if path.ends_with(".py") {
        Some(SourceLanguage::Python)
    } else if path.ends_with(".rs") {
        Some(SourceLanguage::Rust)
    } else {
        None
    }
}

// ============================================================================
// Parser cache — one Mutex<Parser> per language
// ============================================================================

static TS_PARSER: OnceLock<Mutex<Parser>> = OnceLock::new();
static PY_PARSER: OnceLock<Mutex<Parser>> = OnceLock::new();
static RS_PARSER: OnceLock<Mutex<Parser>> = OnceLock::new();

fn get_parser(lang: SourceLanguage) -> &'static Mutex<Parser> {
    match lang {
        SourceLanguage::TypeScript => TS_PARSER.get_or_init(|| {
            let mut p = Parser::new();
            p.set_language(&Language::from(
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            ))
            .expect("valid TS grammar");
            Mutex::new(p)
        }),
        SourceLanguage::Python => PY_PARSER.get_or_init(|| {
            let mut p = Parser::new();
            p.set_language(&Language::from(tree_sitter_python::LANGUAGE))
            .expect("valid Python grammar");
            Mutex::new(p)
        }),
        SourceLanguage::Rust => RS_PARSER.get_or_init(|| {
            let mut p = Parser::new();
            p.set_language(&Language::from(tree_sitter_rust::LANGUAGE))
            .expect("valid Rust grammar");
            Mutex::new(p)
        }),
    }
}


// ============================================================================
// Query cache — one OnceLock<Query> per language + pattern combination
// ============================================================================

macro_rules! cached_query {
    ($fn_name:ident, $lang:expr, $pattern:expr) => {
        fn $fn_name() -> &'static Query {
            static Q: OnceLock<Query> = OnceLock::new();
            Q.get_or_init(|| Query::new(&$lang, $pattern).expect("valid tree-sitter query"))
        }
    };
}

// --- TypeScript queries ---
cached_query!(
    ts_decl_query,
    Language::from(tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
    r#"
[
  (function_declaration name: (identifier) @name) @def
  (generator_function_declaration name: (identifier) @name) @def
  (class_declaration name: (type_identifier) @name) @def
  (interface_declaration name: (type_identifier) @name) @def
  (type_alias_declaration name: (type_identifier) @name) @def
  (enum_declaration name: (identifier) @name) @def
  (method_definition name: (property_identifier) @name) @def
]
"#
);

// Variable declarators — may be arrow functions, function expressions, or plain values.
cached_query!(
    ts_var_query,
    Language::from(tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
    r#"
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (_) @val
  )
) @def
"#
);

// Import statements — all forms.
cached_query!(
    ts_import_query,
    Language::from(tree_sitter_typescript::LANGUAGE_TYPESCRIPT),
    r#"
(import_statement
  source: (string) @source
) @import
"#
);

// --- Python queries ---
cached_query!(
    py_decl_query,
    Language::from(tree_sitter_python::LANGUAGE),
    r#"
[
  (function_definition name: (identifier) @name) @def
  (class_definition name: (identifier) @name) @def
]
"#
);

cached_query!(
    py_import_query,
    Language::from(tree_sitter_python::LANGUAGE),
    r#"
[
  (import_statement) @import
  (import_from_statement module_name: (dotted_name) @module) @import
]
"#
);

// --- Rust queries ---
cached_query!(
    rs_decl_query,
    Language::from(tree_sitter_rust::LANGUAGE),
    r#"
[
  (function_item name: (identifier) @name) @def
  (struct_item name: (type_identifier) @name) @def
  (enum_item name: (type_identifier) @name) @def
  (trait_item name: (type_identifier) @name) @def
  (mod_item name: (identifier) @name) @def
  (const_item name: (identifier) @name) @def
  (static_item name: (identifier) @name) @def
  (impl_item type: (_) @impl_type) @def
]
"#
);

cached_query!(
    rs_use_query,
    Language::from(tree_sitter_rust::LANGUAGE),
    r#"
(use_declaration) @use
"#
);

// ============================================================================
// Public API
// ============================================================================

/// Extract symbols and references from source code.
///
/// Returns a tuple of (symbols, references). Symbols include functions, classes,
/// methods, variables at module/class level. References are imports/uses.
pub fn extract(
    source: &str,
    lang: SourceLanguage,
) -> (Vec<ExtractedSymbol>, Vec<ExtractedReference>) {
    match lang {
        SourceLanguage::TypeScript => extract_ts(source),
        SourceLanguage::Python => extract_py(source),
        SourceLanguage::Rust => extract_rs(source),
    }
}

/// Extract only import/reference lines (used by lsp_structure and file blueprint).
pub fn extract_imports(source: &str, lang: SourceLanguage) -> Vec<String> {
    match lang {
        SourceLanguage::TypeScript => extract_ts_import_lines(source),
        SourceLanguage::Python => extract_py_import_lines(source),
        SourceLanguage::Rust => extract_rs_import_lines(source),
    }
}

/// Find parse errors in source code (used by lsp_diagnostics).
pub fn find_parse_errors(source: &str, lang: SourceLanguage) -> Vec<ParseError> {
    let parser_lock = get_parser(lang);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return vec![],
    };
    let root = tree.root_node();
    let mut errors = Vec::new();
    collect_errors(&root, source, &mut errors);
    errors
}

// ============================================================================
// TypeScript / JavaScript extraction
// ============================================================================

fn extract_ts(source: &str) -> (Vec<ExtractedSymbol>, Vec<ExtractedReference>) {
    let parser_lock = get_parser(SourceLanguage::TypeScript);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return (vec![], vec![]),
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut symbols = Vec::new();

    // --- Pass 1: function/class/interface/type/enum declarations ---
    let decl_query = ts_decl_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(decl_query, root, bytes);
    for m in matches {
        let mut def_node: Option<Node> = None;
        let mut name_node: Option<Node> = None;
        for capture in m.captures {
            match decl_query.capture_names()[capture.index as usize] {
                "def" => def_node = Some(capture.node),
                "name" => name_node = Some(capture.node),
                _ => {}
            }
        }
        if let (Some(def), Some(name)) = (def_node, name_node) {
            if let Some(sym) = classify_ts_symbol(&def, &name, bytes) {
                symbols.push(sym);
            }
        }
    }

    // --- Pass 2: variable declarators (may be arrow functions) ---
    let var_query = ts_var_query();
    let mut cursor2 = QueryCursor::new();
    let var_matches = cursor2.matches(var_query, root, bytes);
    for m in var_matches {
        let mut def_node: Option<Node> = None;
        let mut name_node: Option<Node> = None;
        let mut val_node: Option<Node> = None;
        for capture in m.captures {
            match var_query.capture_names()[capture.index as usize] {
                "def" => def_node = Some(capture.node),
                "name" => name_node = Some(capture.node),
                "val" => val_node = Some(capture.node),
                _ => {}
            }
        }
        if let (Some(def), Some(name)) = (def_node, name_node) {
            if is_top_level(&def) {
                let val_kind = val_node.map(|v| v.kind().to_string());
                let kind = match val_kind.as_deref() {
                    Some("arrow_function") | Some("function_expression") => "function",
                    _ => "variable",
                };
                let exported = check_ts_exported(&def);
                let pos = def.start_position();
                symbols.push(ExtractedSymbol {
                    name: name.utf8_text(bytes).unwrap_or("?").to_string(),
                    kind: kind.to_string(),
                    line: pos.row,
                    column: pos.column,
                    end_line: def.end_position().row,
                    end_column: def.end_position().column,
                    exported,
                    scope: vec![],
                });
            }
        }
    }

    // --- Imports ---
    let references = extract_ts_refs(&root, bytes);

    (symbols, references)
}

/// Classify a TypeScript declaration node.
fn classify_ts_symbol(
    def: &Node,
    name: &Node,
    bytes: &[u8],
) -> Option<ExtractedSymbol> {
    if !is_top_level(def) {
        return None;
    }

    let kind = match def.kind() {
        "function_declaration" | "generator_function_declaration" => "function",
        "class_declaration" => "class",
        "interface_declaration" => "interface",
        "type_alias_declaration" => "type",
        "enum_declaration" => "enum",
        "method_definition" => "method",
        _ => return None,
    };

    let exported = check_ts_exported(def);
    let scope = if kind == "method" {
        // Find enclosing class name
        get_ts_enclosing_class(def, bytes)
    } else {
        vec![]
    };

    let pos = def.start_position();
    Some(ExtractedSymbol {
        name: name.utf8_text(bytes).unwrap_or("?").to_string(),
        kind: kind.to_string(),
        line: pos.row,
        column: pos.column,
        end_line: def.end_position().row,
        end_column: def.end_position().column,
        exported,
        scope,
    })
}

/// Check whether a TS node is at module level or class level (not nested in a function).
fn is_top_level(node: &Node) -> bool {
    match node.parent() {
        Some(ref p) => match p.kind() {
            "program" => true,
            "export_statement" => true,
            "class_body" => true,
            _ => false,
        },
        None => false,
    }
}

/// Check whether a TS declaration is exported.
fn check_ts_exported(node: &Node) -> bool {
    if let Some(parent) = node.parent() {
        if parent.kind() == "export_statement" {
            return true;
        }
    }
    false
}

/// Find the enclosing class name for a method definition.
fn get_ts_enclosing_class(node: &Node, bytes: &[u8]) -> Vec<String> {
    // Walk up from the method_definition: class_body → class_declaration
    if let Some(parent) = node.parent() {
        if parent.kind() == "class_body" {
            if let Some(grandparent) = parent.parent() {
                if grandparent.kind() == "class_declaration" {
                    // Find the name child of class_declaration
                    if let Some(name) = grandparent.child_by_field_name("name") {
                        return vec![name.utf8_text(bytes).unwrap_or("?").to_string()];
                    }
                }
            }
        }
    }
    vec![]
}

/// Extract TypeScript import references by walking the AST.
fn extract_ts_refs(root: &Node, bytes: &[u8]) -> Vec<ExtractedReference> {
    let mut refs = Vec::new();
    let import_query = ts_import_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(import_query, *root, bytes);
    for m in matches {
        let mut source_str: Option<String> = None;
        for capture in m.captures {
            if import_query.capture_names()[capture.index as usize] == "source" {
                let raw = capture.node.utf8_text(bytes).unwrap_or("\"\"");
                // Strip surrounding quotes
                let cleaned = raw
                    .strip_prefix('"')
                    .or_else(|| raw.strip_prefix('\''))
                    .and_then(|s| {
                        s.strip_suffix('"')
                            .or_else(|| s.strip_suffix('\''))
                    })
                    .unwrap_or(raw);
                source_str = Some(cleaned.to_string());
            }
        }
        if let Some(ref source) = source_str {
            let is_rel = source.starts_with("./") || source.starts_with("../");
            // Walk the import_statement to find imported names
            for capture in m.captures {
                if capture.node.kind() == "import_statement" {
                    collect_ts_import_names(&capture.node, bytes, source, is_rel, &mut refs);
                }
            }
        }
    }
    refs
}

/// Walk an import_statement node to extract imported identifier names.
fn collect_ts_import_names(
    node: &Node,
    bytes: &[u8],
    source: &str,
    is_rel: bool,
    refs: &mut Vec<ExtractedReference>,
) {
    // Recurse into children looking for identifier / property_identifier nodes
    // that represent imported names (but not the source string).
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "identifier" | "property_identifier" => {
                    if let Some(parent) = child.parent() {
                        // Skip identifiers that are part of the source string
                        let gp = parent.parent();
                        let is_in_source = gp
                            .map(|g| g.kind() == "string")
                            .unwrap_or(false);
                        if !is_in_source {
                            let name = child.utf8_text(bytes).unwrap_or("?");
                            // Heuristic: skip keywords like "import", "from", "as", "type"
                            if !is_ts_import_keyword(name) {
                                refs.push(ExtractedReference {
                                    name: name.to_string(),
                                    source: source.to_string(),
                                    is_relative: is_rel,
                                });
                            }
                        }
                    }
                }
                _ => {
                    collect_ts_import_names(&child, bytes, source, is_rel, refs);
                }
            }
        }
    }
}

fn is_ts_import_keyword(s: &str) -> bool {
    matches!(s, "import" | "from" | "as" | "type" | "of")
}

/// Extract TypeScript import lines as raw strings.
fn extract_ts_import_lines(source: &str) -> Vec<String> {
    let parser_lock = get_parser(SourceLanguage::TypeScript);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return vec![],
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut lines = Vec::new();
    let import_query = ts_import_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(import_query, root, bytes);
    for m in matches {
        for capture in m.captures {
            if capture.node.kind() == "import_statement" {
                let text = capture.node.utf8_text(bytes).unwrap_or("");
                // Normalize newlines for multi-line imports
                lines.push(text.replace('\n', " "));
            }
        }
    }
    lines
}

// ============================================================================
// Python extraction
// ============================================================================

fn extract_py(source: &str) -> (Vec<ExtractedSymbol>, Vec<ExtractedReference>) {
    let parser_lock = get_parser(SourceLanguage::Python);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return (vec![], vec![]),
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut symbols = Vec::new();

    let decl_query = py_decl_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(decl_query, root, bytes);
    for m in matches {
        let mut def_node: Option<Node> = None;
        let mut name_node: Option<Node> = None;
        for capture in m.captures {
            match decl_query.capture_names()[capture.index as usize] {
                "def" => def_node = Some(capture.node),
                "name" => name_node = Some(capture.node),
                _ => {}
            }
        }
        if let (Some(def), Some(name)) = (def_node, name_node) {
            // Only module-level symbols (parent is "module")
            if !is_py_module_level(&def) {
                continue;
            }
            let kind = match def.kind() {
                "function_definition" => "function",
                "class_definition" => "class",
                _ => continue,
            };
            let name_str = name.utf8_text(bytes).unwrap_or("?").to_string();
            // Python export heuristic: leading _ is private (except __init__)
            let exported = !name_str.starts_with('_') || name_str == "__init__";
            let pos = def.start_position();
            symbols.push(ExtractedSymbol {
                name: name_str,
                kind: kind.to_string(),
                line: pos.row,
                column: pos.column,
                end_line: def.end_position().row,
                end_column: def.end_position().column,
                exported,
                scope: vec![],
            });
        }
    }

    // Imports
    let references = extract_py_refs(&root, bytes);

    (symbols, references)
}

fn is_py_module_level(node: &Node) -> bool {
    match node.parent() {
        Some(ref p) => p.kind() == "module",
        None => false,
    }
}

/// Extract Python import references.
fn extract_py_refs(root: &Node, bytes: &[u8]) -> Vec<ExtractedReference> {
    let mut refs = Vec::new();
    let import_query = py_import_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(import_query, *root, bytes);
    for m in matches {
        let mut is_import_from = false;
        let mut module_name: Option<String> = None;
        let mut import_node: Option<Node> = None;

        for capture in m.captures {
            match import_query.capture_names()[capture.index as usize] {
                "import" => import_node = Some(capture.node),
                "module" => {
                    module_name = Some(capture.node.utf8_text(bytes).unwrap_or("?").to_string());
                    is_import_from = true;
                }
                _ => {}
            }
        }

        if let Some(node) = import_node {
            if is_import_from {
                let module = module_name.unwrap_or_else(|| "?".to_string());
                let is_rel = module.starts_with('.');
                collect_py_import_names(&node, bytes, &module, is_rel, &mut refs);
            } else {
                // Simple `import foo` or `import foo.bar`
                collect_py_import_names(&node, bytes, "", false, &mut refs);
            }
        }
    }
    refs
}

/// Walk a Python import statement node to find imported names.
fn collect_py_import_names(
    node: &Node,
    bytes: &[u8],
    source: &str,
    is_rel: bool,
    refs: &mut Vec<ExtractedReference>,
) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "dotted_name" | "aliased_import" => {
                    // For `from X import Y as Z`, extract Y (first identifier)
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = name_node.utf8_text(bytes).unwrap_or("?");
                        if !is_py_keyword(name) {
                            refs.push(ExtractedReference {
                                name: name.to_string(),
                                source: if source.is_empty() {
                                    child.utf8_text(bytes).unwrap_or("?").to_string()
                                } else {
                                    source.to_string()
                                },
                                is_relative: is_rel || source.starts_with('.'),
                            });
                        }
                    } else {
                        // Simple dotted_name
                        let name = child.utf8_text(bytes).unwrap_or("?");
                        if !is_py_keyword(name) {
                            refs.push(ExtractedReference {
                                name: name.to_string(),
                                source: if source.is_empty() {
                                    name.to_string()
                                } else {
                                    source.to_string()
                                },
                                is_relative: is_rel || source.starts_with('.'),
                            });
                        }
                    }
                }
                _ => {
                    collect_py_import_names(&child, bytes, source, is_rel, refs);
                }
            }
        }
    }
}

fn is_py_keyword(s: &str) -> bool {
    matches!(s, "import" | "from" | "as")
}

/// Extract Python import lines as raw strings.
fn extract_py_import_lines(source: &str) -> Vec<String> {
    let parser_lock = get_parser(SourceLanguage::Python);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return vec![],
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut lines = Vec::new();
    let import_query = py_import_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(import_query, root, bytes);
    for m in matches {
        for capture in m.captures {
            if capture.node.kind() == "import_statement"
                || capture.node.kind() == "import_from_statement"
            {
                let text = capture.node.utf8_text(bytes).unwrap_or("");
                lines.push(text.replace('\n', " "));
            }
        }
    }
    lines
}

// ============================================================================
// Rust extraction
// ============================================================================

fn extract_rs(source: &str) -> (Vec<ExtractedSymbol>, Vec<ExtractedReference>) {
    let parser_lock = get_parser(SourceLanguage::Rust);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return (vec![], vec![]),
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut symbols = Vec::new();

    let decl_query = rs_decl_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(decl_query, root, bytes);
    for m in matches {
        let mut def_node: Option<Node> = None;
        let mut name_node: Option<Node> = None;
        let mut impl_type_node: Option<Node> = None;
        for capture in m.captures {
            match decl_query.capture_names()[capture.index as usize] {
                "def" => def_node = Some(capture.node),
                "name" => name_node = Some(capture.node),
                "impl_type" => impl_type_node = Some(capture.node),
                _ => {}
            }
        }
        if let Some(def) = def_node {
            // Only top-level items (parent is source_file)
            if !is_rs_top_level(&def) {
                continue;
            }
            let kind;
            let disp_name;

            if def.kind() == "impl_item" {
                kind = "impl";
                // Build display name: "TypeName" or "TraitName for TypeName"
                if let Some(type_node) = impl_type_node {
                    let type_name = type_node.utf8_text(bytes).unwrap_or("?").to_string();
                    // Check for trait child
                    let trait_name = def
                        .child_by_field_name("trait")
                        .map(|t| t.utf8_text(bytes).unwrap_or("?").to_string());
                    disp_name = match trait_name {
                        Some(t) => format!("{} for {}", t, type_name),
                        None => type_name,
                    };
                } else {
                    disp_name = "?".to_string();
                }
            } else if let Some(ref name) = name_node {
                disp_name = name.utf8_text(bytes).unwrap_or("?").to_string();
                kind = match def.kind() {
                    "function_item" => "function",
                    "struct_item" => "struct",
                    "enum_item" => "enum",
                    "trait_item" => "trait",
                    "mod_item" => "module",
                    "const_item" => "constant",
                    "static_item" => "variable",
                    _ => continue,
                };
            } else {
                continue;
            }

            let exported = check_rs_visibility(&def, bytes);
            let pos = def.start_position();
            symbols.push(ExtractedSymbol {
                name: disp_name,
                kind: kind.to_string(),
                line: pos.row,
                column: pos.column,
                end_line: def.end_position().row,
                end_column: def.end_position().column,
                exported,
                scope: vec![],
            });
        }
    }

    // Use declarations
    let references = extract_rs_refs(&root, bytes);

    (symbols, references)
}

fn is_rs_top_level(node: &Node) -> bool {
    match node.parent() {
        Some(ref p) => p.kind() == "source_file",
        None => false,
    }
}

/// Check if a Rust item has `pub` visibility.
fn check_rs_visibility(node: &Node, bytes: &[u8]) -> bool {
    // Look for a visibility_modifier child
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "visibility_modifier" {
                let text = child.utf8_text(bytes).unwrap_or("");
                return text.contains("pub");
            }
        }
    }
    false
}

/// Extract Rust use declarations as references.
fn extract_rs_refs(root: &Node, bytes: &[u8]) -> Vec<ExtractedReference> {
    let mut refs = Vec::new();
    let use_query = rs_use_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(use_query, *root, bytes);
    for m in matches {
        for capture in m.captures {
            if capture.node.kind() == "use_declaration" {
                // Extract the full use path and the alias name if any
                collect_rs_use_info(&capture.node, bytes, &mut refs);
            }
        }
    }
    refs
}

/// Walk a use_declaration to extract referenced names.
fn collect_rs_use_info(node: &Node, bytes: &[u8], refs: &mut Vec<ExtractedReference>) {
    // Find the last identifier in the use path as the "name"
    // Look for `use_as_clause` for aliased imports
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "use_as_clause" => {
                    // Has an alias: `use path::to::Thing as Alias`
                    if let Some(alias) = child.child_by_field_name("alias") {
                        let name = alias.utf8_text(bytes).unwrap_or("?");
                        refs.push(ExtractedReference {
                            name: name.to_string(),
                            source: node.utf8_text(bytes).unwrap_or("?").to_string(),
                            is_relative: false,
                        });
                    }
                    return;
                }
                "identifier" | "type_identifier" => {
                    // Collect as individual references
                    let name = child.utf8_text(bytes).unwrap_or("?");
                    if name != "use" && name != "self" && name != "super" && name != "crate" {
                        refs.push(ExtractedReference {
                            name: name.to_string(),
                            source: node.utf8_text(bytes).unwrap_or("?").to_string(),
                            is_relative: false,
                        });
                    }
                }
                _ => {
                    collect_rs_use_info(&child, bytes, refs);
                }
            }
        }
    }
}

/// Extract Rust use lines as raw strings.
fn extract_rs_import_lines(source: &str) -> Vec<String> {
    let parser_lock = get_parser(SourceLanguage::Rust);
    let mut parser = parser_lock.lock().unwrap();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return vec![],
    };
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut lines = Vec::new();
    let use_query = rs_use_query();
    let mut cursor = QueryCursor::new();
    let matches = cursor.matches(use_query, root, bytes);
    for m in matches {
        for capture in m.captures {
            if capture.node.kind() == "use_declaration" {
                let text = capture.node.utf8_text(bytes).unwrap_or("");
                lines.push(text.replace('\n', " "));
            }
        }
    }
    lines
}

// ============================================================================
// Parse error collection (shared)
// ============================================================================

/// Recursively traverse the AST looking for ERROR and MISSING nodes.
fn collect_errors(node: &Node, source: &str, errors: &mut Vec<ParseError>) {
    if node.is_error() || node.is_missing() {
        let pos = node.start_position();
        let snippet: String = source
            .lines()
            .nth(pos.row)
            .unwrap_or("")
            .chars()
            .take(60)
            .collect();
        let msg = if node.is_missing() {
            format!("Missing node: expected content near '{}'", snippet)
        } else {
            format!("Syntax error near '{}'", snippet)
        };
        errors.push(ParseError {
            line: pos.row,
            column: pos.column,
            message: msg,
        });
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_errors(&child, source, errors);
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- language_from_ext ---

    #[test]
    fn test_language_detection() {
        assert_eq!(
            language_from_ext("src/main.ts"),
            Some(SourceLanguage::TypeScript)
        );
        assert_eq!(
            language_from_ext("src/app.tsx"),
            Some(SourceLanguage::TypeScript)
        );
        assert_eq!(
            language_from_ext("src/util.js"),
            Some(SourceLanguage::TypeScript)
        );
        assert_eq!(
            language_from_ext("src/comp.jsx"),
            Some(SourceLanguage::TypeScript)
        );
        assert_eq!(
            language_from_ext("src/main.py"),
            Some(SourceLanguage::Python)
        );
        assert_eq!(
            language_from_ext("src/main.rs"),
            Some(SourceLanguage::Rust)
        );
        assert_eq!(language_from_ext("README.md"), None);
    }

    // --- TypeScript ---

    #[test]
    fn test_ts_function() {
        let src = "function hello() { return 1; }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "hello");
        assert_eq!(syms[0].kind, "function");
        assert!(!syms[0].exported);
    }

    #[test]
    fn test_ts_export_function() {
        let src = "export function hello() { return 1; }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "hello");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_ts_export_async_function() {
        let src = "export async function fetch() { return 1; }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "fetch");
        assert_eq!(syms[0].kind, "function");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_ts_class() {
        let src = "class MyClass { greet() { return 'hi'; } }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        let class = syms.iter().find(|s| s.name == "MyClass").unwrap();
        assert_eq!(class.kind, "class");
        // greet() method should be detected with scope ["MyClass"]
        let method = syms.iter().find(|s| s.name == "greet").unwrap();
        assert_eq!(method.kind, "method");
        assert_eq!(method.scope, vec!["MyClass"]);
    }

    #[test]
    fn test_ts_export_class() {
        let src = "export class MyClass {}";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms[0].name, "MyClass");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_ts_interface() {
        let src = "interface IConfig { key: string; }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "IConfig");
        assert_eq!(syms[0].kind, "interface");
    }

    #[test]
    fn test_ts_type_alias() {
        let src = "type UserId = string;";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "UserId");
        assert_eq!(syms[0].kind, "type");
    }

    #[test]
    fn test_ts_enum() {
        let src = "enum Color { Red, Green, Blue }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "Color");
        assert_eq!(syms[0].kind, "enum");
    }

    #[test]
    fn test_ts_arrow_function() {
        let src = "const greet = () => { return 'hi'; };";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "greet");
        assert_eq!(syms[0].kind, "function"); // arrow function → function
    }

    #[test]
    fn test_ts_function_expression() {
        let src = "const greet = function() { return 'hi'; };";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "greet");
        assert_eq!(syms[0].kind, "function");
    }

    #[test]
    fn test_ts_plain_variable() {
        let src = "const MAX = 100;";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "MAX");
        assert_eq!(syms[0].kind, "variable");
    }

    #[test]
    fn test_ts_nested_function_ignored() {
        let src = "function outer() { function inner() { return 1; } return inner(); }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        // Only outer should be detected; inner is nested
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "outer");
    }

    #[test]
    fn test_ts_nested_const_ignored() {
        let src = "function foo() { const x = 1; return x; }";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        // Only foo should be detected; const x is nested
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "foo");
    }

    #[test]
    fn test_ts_import_named() {
        let src = r#"import { readFile, writeFile } from "node:fs";"#;
        let (_, refs) = extract(src, SourceLanguage::TypeScript);
        let names: Vec<_> = refs.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"readFile"));
        assert!(names.contains(&"writeFile"));
        assert_eq!(refs[0].source, "node:fs");
    }

    #[test]
    fn test_ts_import_default() {
        let src = r#"import express from "express";"#;
        let (_, refs) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "express");
        assert_eq!(refs[0].source, "express");
    }

    #[test]
    fn test_ts_import_type() {
        let src = r#"import type { User } from "./types";"#;
        let (_, refs) = extract(src, SourceLanguage::TypeScript);
        assert!(refs.iter().any(|r| r.name == "User"));
        assert!(refs[0].is_relative);
    }

    #[test]
    fn test_ts_multi_line_function() {
        let src = "export async function\nfetchUser(\n  id: string\n): Promise<User> {\n  return {};\n}";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "fetchUser");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_ts_empty_file() {
        let src = "";
        let (syms, refs) = extract(src, SourceLanguage::TypeScript);
        assert!(syms.is_empty());
        assert!(refs.is_empty());
    }

    #[test]
    fn test_ts_export_const() {
        let src = "export const API_URL = 'https://api.example.com';";
        let (syms, _) = extract(src, SourceLanguage::TypeScript);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "API_URL");
        assert_eq!(syms[0].kind, "variable");
        assert!(syms[0].exported);
    }

    // --- Python ---

    #[test]
    fn test_py_function() {
        let src = "def hello():\n    return 1";
        let (syms, _) = extract(src, SourceLanguage::Python);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "hello");
        assert_eq!(syms[0].kind, "function");
    }

    #[test]
    fn test_py_class() {
        let src = "class MyClass:\n    pass";
        let (syms, _) = extract(src, SourceLanguage::Python);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "MyClass");
        assert_eq!(syms[0].kind, "class");
    }

    #[test]
    fn test_py_private_skipped() {
        let src = "def _private():\n    pass";
        let (syms, _) = extract(src, SourceLanguage::Python);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "_private");
        assert!(!syms[0].exported); // _private is not exported
    }

    #[test]
    fn test_py_init_is_exported() {
        let src = "def __init__(self):\n    pass";
        let (syms, _) = extract(src, SourceLanguage::Python);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "__init__");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_py_nested_function_ignored() {
        let src = "def outer():\n    def inner():\n        pass\n    return inner";
        let (syms, _) = extract(src, SourceLanguage::Python);
        // Only outer should appear
        let names: Vec<_> = syms.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"outer"));
        assert!(!names.contains(&"inner"));
    }

    #[test]
    fn test_py_import() {
        let src = "import os\nimport sys";
        let (_, refs) = extract(src, SourceLanguage::Python);
        let names: Vec<_> = refs.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"os"));
        assert!(names.contains(&"sys"));
    }

    #[test]
    fn test_py_from_import() {
        let src = "from pathlib import Path, PurePath";
        let (_, refs) = extract(src, SourceLanguage::Python);
        let names: Vec<_> = refs.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"Path"));
        assert!(names.contains(&"PurePath"));
    }

    // --- Rust ---

    #[test]
    fn test_rs_function() {
        let src = "fn hello() -> i32 { 1 }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "hello");
        assert_eq!(syms[0].kind, "function");
        assert!(!syms[0].exported);
    }

    #[test]
    fn test_rs_pub_function() {
        let src = "pub fn hello() -> i32 { 1 }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "hello");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_rs_pub_async_function() {
        let src = "pub async fn fetch() -> String { String::new() }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "fetch");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_rs_struct() {
        let src = "pub struct User { name: String }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms[0].name, "User");
        assert_eq!(syms[0].kind, "struct");
        assert!(syms[0].exported);
    }

    #[test]
    fn test_rs_enum() {
        let src = "pub enum Result2 { Ok, Err }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms[0].name, "Result2");
        assert_eq!(syms[0].kind, "enum");
    }

    #[test]
    fn test_rs_trait() {
        let src = "pub trait Serialize { fn serialize(&self); }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        let trait_sym = syms.iter().find(|s| s.kind == "trait").unwrap();
        assert_eq!(trait_sym.name, "Serialize");
    }

    #[test]
    fn test_rs_impl() {
        let src = "impl User { fn new() -> Self { User { name: String::new() } } }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        let impl_sym = syms.iter().find(|s| s.kind == "impl").unwrap();
        assert_eq!(impl_sym.name, "User");
    }

    #[test]
    fn test_rs_trait_impl() {
        let src = "impl Serialize for User { fn serialize(&self) {} }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        let impl_sym = syms.iter().find(|s| s.kind == "impl").unwrap();
        assert_eq!(impl_sym.name, "Serialize for User");
    }

    #[test]
    fn test_rs_mod() {
        let src = "pub mod utils;";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms[0].name, "utils");
        assert_eq!(syms[0].kind, "module");
    }

    #[test]
    fn test_rs_use() {
        let src = "use std::collections::HashMap;";
        let (_, refs) = extract(src, SourceLanguage::Rust);
        assert!(refs.iter().any(|r| r.name == "HashMap"));
    }

    #[test]
    fn test_rs_use_alias() {
        let src = "use std::io::Result as IoResult;";
        let (_, refs) = extract(src, SourceLanguage::Rust);
        assert!(refs.iter().any(|r| r.name == "IoResult"));
    }

    #[test]
    fn test_rs_const() {
        let src = "const MAX_SIZE: usize = 1024;";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms[0].name, "MAX_SIZE");
        assert_eq!(syms[0].kind, "constant");
    }

    #[test]
    fn test_rs_nested_fn_ignored() {
        let src = "fn outer() { fn inner() {} inner(); }";
        let (syms, _) = extract(src, SourceLanguage::Rust);
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].name, "outer");
    }

    #[test]
    fn test_rs_empty() {
        let src = "";
        let (syms, refs) = extract(src, SourceLanguage::Rust);
        assert!(syms.is_empty());
        assert!(refs.is_empty());
    }

    // --- extract_imports ---

    #[test]
    fn test_extract_imports_ts() {
        let src = "import { a } from 'b';\nimport c from 'd';";
        let lines = extract_imports(src, SourceLanguage::TypeScript);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_extract_imports_py() {
        let src = "import os\nfrom pathlib import Path";
        let lines = extract_imports(src, SourceLanguage::Python);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn test_extract_imports_rs() {
        let src = "use std::io;\nuse crate::util;";
        let lines = extract_imports(src, SourceLanguage::Rust);
        assert_eq!(lines.len(), 2);
    }

    // --- Parse errors ---

    #[test]
    fn test_parse_errors_valid_code() {
        let src = "fn main() {}";
        let errs = find_parse_errors(src, SourceLanguage::Rust);
        assert!(errs.is_empty());
    }

    #[test]
    fn test_parse_errors_syntax_error() {
        let src = "fn main( { }";
        let errs = find_parse_errors(src, SourceLanguage::Rust);
        assert!(!errs.is_empty(), "should detect parse error");
    }
}
