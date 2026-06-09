/// File tool implementations — read, write, edit, glob, grep, ls.
///
/// These are the most-used tools in any coding agent. Correctness is critical:
///   - `edit` must actually change the file (SDB Step 5 verifies this)
///   - `write` must be atomic where possible
///   - `grep` must handle large codebases efficiently

use std::sync::Arc;

use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};

/// Default max grep results returned.
const DEFAULT_MAX_RESULTS: usize = 250;
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
        "Read a file from the local filesystem. Supports offset and limit for large files."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to read"
                },
                "offset": {
                    "type": "number",
                    "description": "Line number to start reading from (0-indexed)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of lines to read"
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };

        let path = normalize_path(path);

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Cannot read '{}': {}", path, e)),
        };

        // Apply offset/limit if provided
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

        let header = format!(
            "File: {} (lines {}-{} of {})\n\n",
            path,
            start + 1,
            end,
            total_lines
        );

        ToolOutput::success(header + &output)
    }
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };
        let content = match args.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: content"),
        };

        let path = normalize_path(path);

        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(&path).parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot create parent directory for '{}': {}", path, e),
                );
            }
        }

        match std::fs::write(&path, content) {
            Ok(()) => ToolOutput::success(format!(
                "Wrote {} bytes to '{}'",
                content.len(),
                path
            )),
            Err(e) => ToolOutput::error(
                "EXECUTION_FAILED",
                format!("Cannot write '{}': {}", path, e),
            ),
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };
        let old_string = match args.get("old_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: old_string"),
        };
        let new_string = match args.get("new_string").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: new_string"),
        };
        let replace_all = args
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let path = normalize_path(path);

        let original = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Cannot read '{}': {}", path, e),
                )
            }
        };

        if old_string.is_empty() {
            return ToolOutput::error("SCHEMA_INVALID", "old_string must not be empty");
        }

        let occurrences = original.matches(old_string).count();

        if occurrences == 0 {
            return ToolOutput::error(
                "EXECUTION_FAILED",
                format!(
                    "old_string not found in '{}'. The file may have changed since you last read it.",
                    path
                ),
            );
        }

        if !replace_all && occurrences > 1 {
            return ToolOutput::error(
                "EXECUTION_FAILED",
                format!(
                    "old_string found {} times in '{}'. Use replace_all: true or make old_string more specific.",
                    occurrences, path
                ),
            );
        }

        let modified = if replace_all {
            original.replace(old_string, new_string)
        } else {
            original.replacen(old_string, new_string, 1)
        };

        match std::fs::write(&path, &modified) {
            Ok(()) => {
                let replaced_count = if replace_all { occurrences } else { 1 };
                ToolOutput::success(format!(
                    "Replaced {} occurrence(s) of old_string in '{}'",
                    replaced_count, path
                ))
            }
            Err(e) => ToolOutput::error(
                "EXECUTION_FAILED",
                format!("Cannot write '{}': {}", path, e),
            ),
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: path"),
        };

        let path = normalize_path(path);

        match std::fs::remove_file(&path) {
            Ok(()) => ToolOutput::success(format!("Deleted '{}'", path)),
            Err(e) => ToolOutput::error(
                "EXECUTION_FAILED",
                format!("Cannot delete '{}': {}", path, e),
            ),
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: pattern"),
        };

        let base_path = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ctx.project_path.clone());

        let base_path = normalize_path(&base_path);

        let full_pattern = if base_path.ends_with('/') {
            format!("{}{}", base_path, pattern.trim_start_matches('/'))
        } else {
            format!("{}/{}", base_path, pattern.trim_start_matches('/'))
        };

        let results: Vec<String> = match glob::glob(&full_pattern) {
            Ok(paths) => paths
                .filter_map(|entry| entry.ok())
                .map(|p| normalize_path(&p.to_string_lossy()))
                .collect(),
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Glob pattern error: {}", e),
                )
            }
        };

        if results.is_empty() {
            ToolOutput::success("No files matched.".to_string())
        } else {
            ToolOutput::success(results.join("\n"))
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
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: pattern"),
        };

        let regex = match regex::Regex::new(pattern) {
            Ok(r) => r,
            Err(e) => {
                return ToolOutput::error(
                    "SCHEMA_INVALID",
                    format!("Invalid regex pattern: {}", e),
                )
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
            return ToolOutput::error(
                "EXECUTION_FAILED",
                format!("Path not found: '{}'", search_path),
            );
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
            ToolOutput::success("No matches found.".to_string())
        } else {
            let summary = format!("Found {} match(es):\n\n{}", results.len(), results.join("\n"));
            ToolOutput::success(summary)
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
            ToolOutput::success(format!("Directory '{}' is empty.", dir_path))
        } else {
            let header = format!("Listing '{}' ({} entries):\n\n", dir_path, listing.len());
            ToolOutput::success(header + &listing.join("\n"))
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
