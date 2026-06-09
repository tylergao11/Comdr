/// SDB Gate — 6-step validation pipeline for tool execution.
///
/// This is Comdr's core defense against silent failures:
///
///   Step 1: Schema Validate  — JSON Schema validation of arguments
///   Step 2: Permission Check — read_only / destructive / requires_approval
///   Step 3: Pre-snapshot     — backup files before destructive writes
///   Step 4: Execute          — run the tool with timeout
///   Step 5: Diff Validate    — compare actual vs expected changes
///   Step 6: Test Feedback    — auto-run affected tests, rollback on failure
///
/// ## Related Cline bugs this prevents:
///   - replace_in_file no-op  → Step 5 catches zero-diff edits
///   - Overconfident fix claim → Step 6 verifies with test feedback
///   - Irrecoverable damage   → Step 3 snapshot enables rollback

use crate::snapshot::FileSnapshot;
use crate::tools::{ToolContext, ToolOutput, ToolPermission, ToolRegistry};
use crate::JsExecuteOptions;
use crate::JsExecuteResult;
use crate::JsToolDefinition;
use jsonschema::JSONSchema;
use serde_json::Value;
use indexmap::IndexMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

mod test_feedback;

// ============================================================================
// SdbGate
// ============================================================================

/// Max number of active snapshots before oldest are evicted.
const MAX_SNAPSHOTS: usize = 100;

pub struct SdbGate {
    registry: ToolRegistry,
    /// Active snapshots, keyed by snapshot ID. Available for rollback.
    /// Uses IndexMap for deterministic FIFO eviction (insertion order = age).
    snapshots: Mutex<IndexMap<String, FileSnapshot>>,
    /// Handle to the previous timeout thread, if still running.
    /// Joined before spawning a new one to prevent orphan accumulation.
    prev_thread: Mutex<Option<JoinHandle<()>>>,
    /// Cached tool definitions (populated once, read many times).
    cached_tools: OnceLock<Vec<JsToolDefinition>>,
}

impl SdbGate {
    pub fn new() -> Self {
        Self {
            registry: ToolRegistry::new(),
            snapshots: Mutex::new(IndexMap::new()),
            prev_thread: Mutex::new(None),
            cached_tools: OnceLock::new(),
        }
    }

    /// Register all built-in tools. Called once during initialization.
    pub fn register_all(&mut self) {
        crate::tools::file::register_all(&mut self.registry);
        crate::tools::shell::register_all(&mut self.registry);
        crate::tools::git::register_all(&mut self.registry);
        crate::tools::lsp::register_all(&mut self.registry);
    }

    /// Return cached tool definitions (populated once on first call).
    pub fn cached_tools(&self) -> Vec<JsToolDefinition> {
        self.cached_tools
            .get_or_init(|| {
                self.registry
                    .list_definitions()
                    .into_iter()
                    .map(|td| JsToolDefinition {
                        name: td.name,
                        description: td.description,
                        parameters: td.parameters,
                        permission: match &td.permission {
                            ToolPermission::ReadOnly => "read_only".to_string(),
                            ToolPermission::Destructive => "destructive".to_string(),
                            ToolPermission::RequiresApproval => "requires_approval".to_string(),
                        },
                        timeout_ms: td.timeout_ms,
                    })
                    .collect()
            })
            .clone()
    }

    /// Execute a tool through the full SDB 6-step pipeline.
    pub fn execute(&self, opts: JsExecuteOptions) -> JsExecuteResult {
        let start = Instant::now();
        let tool_name = opts.name.clone();
        let args = opts.arguments;

        // Look up tool
        let tool = match self.registry.get(&tool_name) {
            Some(t) => t,
            None => {
                return JsExecuteResult {
                    ok: false,
                    content: Some(format!("Unknown tool: '{}'", tool_name)),
                    error_category: Some("execution_error".to_string()),
                    diff_summary: None,
                    snapshot_id: None,
                    duration_ms: 0.0,
                    test_passed: None,
                    test_failed: None,
                    test_output: None,
                    test_file: None,
                };
            }
        };

        let ctx = ToolContext {
            project_path: opts.project_path.unwrap_or_default(),
        };

        // ── Step 1: Schema Validate ──
        let schema = tool.parameters();
        if let Err(e) = Self::validate_schema(&schema, &args) {
            return JsExecuteResult {
                ok: false,
                content: Some(e),
                error_category: Some("schema_invalid".to_string()),
                diff_summary: None,
                snapshot_id: None,
                duration_ms: 0.0,
                test_passed: None,
                test_failed: None,
                test_output: None,
                test_file: None,
            };
        }

        // ── Step 2: Permission Check ──
        // (Pass-through — permission mode enforcement is done by Agent 4)

        // ── Step 3: Pre-snapshot ──
        let is_destructive = !matches!(tool.permission(), ToolPermission::ReadOnly);
        // Step 3: Always snapshot destructive ops (SDB gate decides, not caller)
        let snapshot = if is_destructive {
            let files = Self::extract_file_paths(&tool_name, &args);
            if !files.is_empty() {
                match FileSnapshot::capture(&files) {
                    Ok(snap) => Some(snap),
                    Err(e) => {
                        return JsExecuteResult {
                            ok: false,
                            content: Some(format!("Snapshot failed: {}", e)),
                            error_category: Some("snapshot_failed".to_string()),
                            diff_summary: None,
                            snapshot_id: None,
                            duration_ms: 0.0,
                            test_passed: None,
                            test_failed: None,
                            test_output: None,
                            test_file: None,
                        };
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // ── Step 4: Execute (with timeout) ──
        let timeout_ms = if opts.timeout_ms > 0 {
            opts.timeout_ms as u64
        } else {
            tool.timeout_ms() as u64
        };

        let exec_result =
            self.execute_with_timeout(Arc::clone(&tool), &args, &ctx, timeout_ms);

        // ── Step 5: Diff Validate ──
        // ★ diff 全量输出——不再在 Rust 层硬截断。
        // 智能压缩（head + tail + body sample）由 Agent 4 的 summarizeDiff() 负责。
        let mut diff_is_empty = false;
        let diff_summary = if is_destructive {
            snapshot.as_ref().and_then(|snap| {
                snap.diff().ok().and_then(|diff| {
                    let trimmed = diff.trim();
                    if trimmed.is_empty() {
                        diff_is_empty = true;
                        Some("(no changes detected)".to_string())
                    } else {
                        Some(trimmed.to_string())
                    }
                })
            })
        } else {
            None
        };

        // ── Step 6: Test Feedback ──
        // Auto-discover and run affected tests via convention-based mapping.
        // Only for destructive file ops where a diff was produced.
        let test_feedback = if is_destructive && !diff_is_empty {
            if let Some(path) = Self::first_modified_path(&tool_name, &args) {
                let project_root = ctx.project_path.clone();
                Some(test_feedback::run_test_feedback(
                    &tool_name, &path, &project_root,
                ))
            } else {
                None
            }
        } else {
            None
        };

        // Store snapshot for potential later rollback (evict oldest if over limit)
        let snapshot_id = if let Some(snap) = snapshot {
            let id = snap.id.clone();
            if let Ok(mut guard) = self.snapshots.lock() {
                if guard.len() >= MAX_SNAPSHOTS {
                    // Evict the oldest snapshot (IndexMap preserves insertion order)
                    if let Some(oldest_key) = guard.keys().next().cloned() {
                        guard.shift_remove(&oldest_key);
                    }
                }
                guard.insert(id.clone(), snap);
            }
            Some(id)
        } else {
            None
        };

        // ── Determine error_category ──
        let error_category = if !exec_result.ok {
            match exec_result.error_code.as_deref() {
                Some("TIMEOUT") => Some("timeout".to_string()),
                _ => Some("execution_error".to_string()),
            }
        } else if is_destructive && diff_is_empty {
            // Step 5: tool claimed success but zero diff — Cline no-op pattern
            Some("diff_mismatch".to_string())
        } else {
            None
        };

        // If diff_mismatch detected, flip ok to false
        let ok = exec_result.ok && error_category.as_deref() != Some("diff_mismatch");

        // ── Build result (only error_category, no error_code) ──
        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

        // Extract test feedback into JsExecuteResult fields
        let (test_passed, test_failed, test_output, test_file) = match &test_feedback {
            Some(test_feedback::TestFeedbackResult::Passed { passed, test_file: tf }) => {
                (Some(*passed as i32), Some(0i32), None, Some(tf.clone()))
            }
            Some(test_feedback::TestFeedbackResult::Failed { passed, failed, test_file: tf, output }) => {
                (Some(*passed as i32), Some(*failed as i32), Some(output.clone()), Some(tf.clone()))
            }
            Some(test_feedback::TestFeedbackResult::ExecutionError { message }) => {
                (None, None, Some(message.clone()), None)
            }
            Some(test_feedback::TestFeedbackResult::Skipped) | None => {
                (None, None, None, None)
            }
        };

        JsExecuteResult {
            ok,
            content: exec_result.content,
            error_category,
            diff_summary,
            snapshot_id,
            duration_ms,
            test_passed,
            test_failed,
            test_output,
            test_file,
        }
    }

    /// Rollback to a previously captured snapshot (restores + removes).
    pub fn rollback(&self, snapshot_id: &str) -> bool {
        self.remove_snapshot(snapshot_id, |s| s.restore().is_ok())
    }

    /// Discard a snapshot without restoring (cleanup after successful self-correct).
    pub fn forget_snapshot(&self, snapshot_id: &str) -> bool {
        self.remove_snapshot(snapshot_id, |_| true)
    }

    fn remove_snapshot(&self, snapshot_id: &str, action: impl FnOnce(&crate::snapshot::FileSnapshot) -> bool) -> bool {
        match self.snapshots.lock() {
            Ok(mut snapshots) => {
                if let Some(snapshot) = snapshots.swap_remove(snapshot_id) {
                    action(&snapshot)
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }
}

// ============================================================================
// Private helpers
// ============================================================================

impl SdbGate {
    /// Step 1: Validate arguments against the tool's JSON Schema.
    fn validate_schema(schema: &Value, args: &Value) -> Result<(), String> {
        let compiled =
            JSONSchema::compile(schema).map_err(|e| format!("Schema compile error: {}", e))?;
        let result = compiled.validate(args);
        if let Err(errors) = result {
            let messages: Vec<String> = errors.map(|e| e.to_string()).collect();
            return Err(format!(
                "Schema validation failed:\n{}",
                messages.join("\n")
            ));
        }
        Ok(())
    }

    /// Step 4: Execute with timeout enforcement via channel + thread.
    ///
    /// Spawns the tool on a separate thread and waits on a channel with timeout.
    /// The previous orphaned timeout thread (if any) is joined before spawning
    /// to prevent unbounded thread accumulation.
    fn execute_with_timeout(
        &self,
        tool: Arc<dyn crate::tools::Tool>,
        args: &Value,
        ctx: &ToolContext,
        timeout_ms: u64,
    ) -> ToolOutput {
        if timeout_ms == 0 {
            return tool.execute(args, ctx);
        }

        // Join any previous orphaned timeout thread before spawning a new one.
        if let Ok(mut guard) = self.prev_thread.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join(); // Ignore result — old thread is done or panicked
            }
            // Ensure the lock is dropped before spawning (avoid holding across spawn).
            drop(guard);
        }

        let args_owned = args.clone();
        let ctx_owned = ToolContext {
            project_path: ctx.project_path.clone(),
        };

        let (tx, rx) = mpsc::channel();

        let handle = std::thread::spawn(move || {
            let result = tool.execute(&args_owned, &ctx_owned);
            let _ = tx.send(result); // Ignore error if receiver dropped (timeout)
        });

        let output = match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(output) => {
                // Tool completed within timeout — join the thread to clean up.
                let _ = handle.join();
                output
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Store the handle so the next call can join it.
                if let Ok(mut guard) = self.prev_thread.lock() {
                    *guard = Some(handle);
                }
                ToolOutput::error(
                    "TIMEOUT",
                    format!("Tool timed out after {}ms", timeout_ms),
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = handle.join();
                ToolOutput::error("EXECUTION_FAILED", "Tool thread panicked")
            }
        };

        output
    }

    /// Extract the first file path from tool args (for test feedback targeting).
    fn first_modified_path(tool_name: &str, args: &Value) -> Option<String> {
        match tool_name {
            "file_write" | "file_edit" | "file_delete" => {
                args.get("path").and_then(|v| v.as_str()).map(|s| s.to_string())
            }
            _ => None,
        }
    }

    /// Extract file paths from tool arguments (for snapshot targeting).
    fn extract_file_paths(tool_name: &str, args: &Value) -> Vec<String> {
        let path_keys: &[&str] = match tool_name {
            "file_write" | "file_edit" | "file_delete" => &["path"],
            "git_add" => &["files"],
            _ => return vec![],
        };

        let mut paths = Vec::new();
        for key in path_keys {
            if let Some(val) = args.get(*key) {
                match val {
                    Value::String(s) => paths.push(s.clone()),
                    Value::Array(arr) => {
                        for item in arr {
                            if let Some(s) = item.as_str() {
                                paths.push(s.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        paths
    }
}
