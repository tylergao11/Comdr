/// Git tool implementations — diff, status, log, add, commit, revert.
///
/// Uses the `git2` crate (libgit2 bindings) for safe, cross-platform git operations.
/// All operations are scoped to the project's git repository.

use std::sync::Arc;

use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};
use serde_json::Value;

/// Default number of commits shown by git_log.
const DEFAULT_LOG_COUNT: usize = 20;

/// Build and return all git-related tool instances.
pub fn register_all(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Arc::new(GitDiffTool));
    registry.register(Arc::new(GitStatusTool));
    registry.register(Arc::new(GitLogTool));
    registry.register(Arc::new(GitAddTool));
    registry.register(Arc::new(GitCommitTool));
    registry.register(Arc::new(GitRevertTool));
}

// ============================================================================
// Helpers
// ============================================================================

/// Open the git repository at the given path (or walk up to find it).
fn open_repo(path: &str) -> Result<git2::Repository, String> {
    git2::Repository::discover(path).map_err(|e| format!("Not a git repository: {}", e))
}

// ============================================================================
// git_diff
// ============================================================================

struct GitDiffTool;

impl Tool for GitDiffTool {
    fn name(&self) -> &str {
        "git_diff"
    }

    fn description(&self) -> &str {
        "Show changes in the working directory (unified diff format)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Specific file or directory to diff (default: entire repo)"
                },
                "staged": {
                    "type": "boolean",
                    "description": "Show staged changes instead of working directory changes",
                    "default": false
                }
            },
            "required": []
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        15000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let staged = args.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);

        // Get the diff
        let mut diff_opts = git2::DiffOptions::new();
        if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
            diff_opts.pathspec(path);
        }

        let diff = if staged {
            // Staged changes: diff between HEAD and index
            let head = repo.head().ok();
            let head_tree = head
                .as_ref()
                .and_then(|h| h.peel_to_tree().ok());
            match head_tree {
                Some(tree) => repo
                    .diff_tree_to_index(Some(&tree), None, Some(&mut diff_opts))
                    .map_err(|e| format!("Diff error: {}", e)),
                None => repo
                    .diff_tree_to_index(None, None, Some(&mut diff_opts))
                    .map_err(|e| format!("Diff error: {}", e)),
            }
        } else {
            // Working directory changes: diff between index and working tree
            repo.diff_index_to_workdir(None, Some(&mut diff_opts))
                .map_err(|e| format!("Diff error: {}", e))
        };

        let diff = match diff {
            Ok(d) => d,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        // Render diff as text
        let mut output = String::new();
        let print_result = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                '>' => ">",
                '<' => "<",
                'F' => "F",
                'H' => "H",
                'B' => "B",
                _ => " ",
            };
            output.push_str(prefix);
            output.push_str(
                std::str::from_utf8(line.content()).unwrap_or("[binary]"),
            );
            true
        });

        if let Err(e) = print_result {
            return ToolOutput::error("EXECUTION_FAILED", format!("Diff render error: {}", e));
        }

        if output.trim().is_empty() {
            ToolOutput::success("No changes (working tree clean).")
        } else {
            ToolOutput::success(output)
        }
    }
}

// ============================================================================
// git_status
// ============================================================================

struct GitStatusTool;

impl Tool for GitStatusTool {
    fn name(&self) -> &str {
        "git_status"
    }

    fn description(&self) -> &str {
        "Show the working tree status (porcelain format)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Specific path to check status for"
                }
            },
            "required": []
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let mut status_opts = git2::StatusOptions::new();
        status_opts
            .include_untracked(true)
            .renames_head_to_index(true);
        if let Some(path) = args.get("path").and_then(|v| v.as_str()) {
            status_opts.pathspec(path);
        }

        let statuses = match repo.statuses(Some(&mut status_opts)) {
            Ok(s) => s,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Status error: {}", e)),
        };

        if statuses.is_empty() {
            return ToolOutput::success("Nothing to commit, working tree clean.");
        }

        let mut output = String::new();
        for entry in statuses.iter() {
            let status_code = status_flags_to_code(entry.status());
            let path = entry.path().unwrap_or("<unknown>");
            output.push_str(&format!("{} {}\n", status_code, path));
        }

        ToolOutput::success(output)
    }
}

/// Convert git2::Status flags to a 2-character porcelain status code.
fn status_flags_to_code(flags: git2::Status) -> &'static str {
    // Index (staged) vs working tree
    match () {
        _ if flags.contains(git2::Status::INDEX_NEW) => "A ",
        _ if flags.contains(git2::Status::INDEX_MODIFIED) => "M ",
        _ if flags.contains(git2::Status::INDEX_DELETED) => "D ",
        _ if flags.contains(git2::Status::INDEX_RENAMED) => "R ",
        _ if flags.contains(git2::Status::INDEX_TYPECHANGE) => "T ",
        _ if flags.contains(git2::Status::WT_NEW) => "??",
        _ if flags.contains(git2::Status::WT_MODIFIED) => " M",
        _ if flags.contains(git2::Status::WT_DELETED) => " D",
        _ if flags.contains(git2::Status::WT_RENAMED) => " R",
        _ if flags.contains(git2::Status::WT_TYPECHANGE) => " T",
        _ if flags.contains(git2::Status::IGNORED) => "!!",
        _ if flags.contains(git2::Status::CONFLICTED) => "UU",
        _ => "  ",
    }
}

// ============================================================================
// git_log
// ============================================================================

struct GitLogTool;

impl Tool for GitLogTool {
    fn name(&self) -> &str {
        "git_log"
    }

    fn description(&self) -> &str {
        "Show recent commit history."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "count": {
                    "type": "number",
                    "description": "Number of recent commits to show (default: 20)",
                    "default": 20
                }
            },
            "required": []
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::ReadOnly
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let count = args
            .get("count")
            .and_then(|v| v.as_f64())
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_LOG_COUNT);

        let mut revwalk = match repo.revwalk() {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Revwalk error: {}", e)),
        };

        revwalk.push_head().map_err(|e| format!("Push head error: {}", e)).unwrap_or(());

        let mut output = String::new();
        for (i, oid) in revwalk.take(count).enumerate() {
            let oid = match oid {
                Ok(o) => o,
                Err(_) => continue,
            };

            let commit = match repo.find_commit(oid) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let hash = &oid.to_string()[..8.min(oid.to_string().len())];
            let author_name = commit.author();
            let author = author_name.name().unwrap_or("unknown");
            let summary = commit.summary().unwrap_or("");
            let time = commit.time().seconds();

            if i == 0 {
                output.push_str(&format!(
                    "{} (HEAD) {} - {} @ {}\n",
                    hash, summary, author, time
                ));
            } else {
                output.push_str(&format!(
                    "{} {} - {} @ {}\n",
                    hash, summary, author, time
                ));
            }
        }

        if output.is_empty() {
            ToolOutput::success("No commits found.")
        } else {
            ToolOutput::success(output)
        }
    }
}

// ============================================================================
// git_add
// ============================================================================

struct GitAddTool;

impl Tool for GitAddTool {
    fn name(&self) -> &str {
        "git_add"
    }

    fn description(&self) -> &str {
        "Stage files for commit. Accepts a single file path or an array of file paths."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "files": {
                    "description": "File path(s) to stage. String for single file, array for multiple."
                }
            },
            "required": ["files"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        10000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let files_val = match args.get("files") {
            Some(v) => v,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: files"),
        };

        let paths: Vec<String> = match files_val {
            Value::String(s) => vec![s.clone()],
            Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => {
                return ToolOutput::error(
                    "SCHEMA_INVALID",
                    "files must be a string or array of strings",
                )
            }
        };

        let mut index = match repo.index() {
            Ok(i) => i,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Index error: {}", e)),
        };

        let mut added = 0;
        for path in &paths {
            match index.add_path(std::path::Path::new(path)) {
                Ok(()) => added += 1,
                Err(e) => {
                    return ToolOutput::error(
                        "EXECUTION_FAILED",
                        format!("Cannot add '{}': {}", path, e),
                    )
                }
            }
        }

        match index.write() {
            Ok(()) => ToolOutput::success(format!("Staged {} file(s): {:?}", added, paths)),
            Err(e) => ToolOutput::error("EXECUTION_FAILED", format!("Index write error: {}", e)),
        }
    }
}

// ============================================================================
// git_commit
// ============================================================================

struct GitCommitTool;

impl Tool for GitCommitTool {
    fn name(&self) -> &str {
        "git_commit"
    }

    fn description(&self) -> &str {
        "Commit staged changes with a message."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "Commit message"
                }
            },
            "required": ["message"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        15000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let message = match args.get("message").and_then(|v| v.as_str()) {
            Some(m) => m,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: message"),
        };

        // Get the current index as a tree
        let mut index = match repo.index() {
            Ok(i) => i,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Index error: {}", e)),
        };

        let tree_oid = match index.write_tree() {
            Ok(oid) => oid,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Nothing to commit ({}). Use git_add first.", e),
                )
            }
        };

        let tree = match repo.find_tree(tree_oid) {
            Ok(t) => t,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", format!("Tree error: {}", e)),
        };

        // Get or create the parent commit
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

        let signature = match repo.signature() {
            Ok(s) => s,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("No git user configured: {}", e),
                )
            }
        };

        let parents: Vec<&git2::Commit> = parent.iter().collect();

        match repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents) {
            Ok(oid) => ToolOutput::success(format!("Committed: {}", oid)),
            Err(e) => ToolOutput::error("EXECUTION_FAILED", format!("Commit error: {}", e)),
        }
    }
}

// ============================================================================
// git_revert
// ============================================================================

struct GitRevertTool;

impl Tool for GitRevertTool {
    fn name(&self) -> &str {
        "git_revert"
    }

    fn description(&self) -> &str {
        "Revert a commit by its hash. Creates a new commit that undoes the specified commit."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "commit": {
                    "type": "string",
                    "description": "Commit hash to revert"
                }
            },
            "required": ["commit"]
        })
    }

    fn permission(&self) -> ToolPermission {
        ToolPermission::Destructive
    }

    fn timeout_ms(&self) -> u32 {
        15000
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let repo = match open_repo(&ctx.project_path) {
            Ok(r) => r,
            Err(e) => return ToolOutput::error("EXECUTION_FAILED", e),
        };

        let commit_hash = match args.get("commit").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return ToolOutput::error("SCHEMA_INVALID", "Missing required field: commit"),
        };

        let oid = match git2::Oid::from_str(commit_hash) {
            Ok(o) => o,
            Err(e) => {
                return ToolOutput::error(
                    "SCHEMA_INVALID",
                    format!("Invalid commit hash '{}': {}", commit_hash, e),
                )
            }
        };

        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Commit not found '{}': {}", commit_hash, e),
                )
            }
        };

        // Revert the commit (creates a new revert commit)
        match repo.revert(&commit, None) {
            Ok(()) => {
                // Check if there are conflicts
                let mut status_opts = git2::StatusOptions::new();
                status_opts.include_untracked(false);
                if let Ok(statuses) = repo.statuses(Some(&mut status_opts)) {
                    if statuses.iter().any(|s| s.status().contains(git2::Status::CONFLICTED)) {
                        return ToolOutput {
                            ok: false,
                            content: Some(format!(
                                "Revert of '{}' caused conflicts. Resolve manually and commit.",
                                commit_hash
                            )),
                            error_code: Some("EXECUTION_FAILED".to_string()),
                        };
                    }
                }

                // Auto-commit the revert
                let mut index = match repo.index() {
                    Ok(i) => i,
                    Err(e) => {
                        return ToolOutput::error("EXECUTION_FAILED", format!("Index error: {}", e))
                    }
                };
                let tree_oid = match index.write_tree() {
                    Ok(oid) => oid,
                    Err(e) => {
                        return ToolOutput::error(
                            "EXECUTION_FAILED",
                            format!("Tree error: {}", e),
                        )
                    }
                };
                let tree = match repo.find_tree(tree_oid) {
                    Ok(t) => t,
                    Err(e) => {
                        return ToolOutput::error(
                            "EXECUTION_FAILED",
                            format!("Tree error: {}", e),
                        )
                    }
                };

                let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
                let signature = match repo.signature() {
                    Ok(s) => s,
                    Err(e) => {
                        return ToolOutput::error(
                            "EXECUTION_FAILED",
                            format!("No git user: {}", e),
                        )
                    }
                };
                let parents: Vec<&git2::Commit> = parent.iter().collect();

                match repo.commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    &format!("Revert '{}'", commit_hash),
                    &tree,
                    &parents,
                ) {
                    Ok(oid) => ToolOutput::success(format!(
                        "Reverted commit '{}' as {}",
                        commit_hash, oid
                    )),
                    Err(e) => {
                        ToolOutput::error("EXECUTION_FAILED", format!("Revert commit error: {}", e))
                    }
                }
            }
            Err(e) => ToolOutput::error("EXECUTION_FAILED", format!("Revert error: {}", e)),
        }
    }
}
