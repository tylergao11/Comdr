/// lib.rs — napi-rs export entry point for comdr-tools.
///
/// This module implements **Contract B (INativeTools)**:
///   - `execute(opts)`   → runs a tool through the SDB 6-step pipeline
///   - `rollback(id)`    → restores files to a snapshot
///   - `list_tools()`    → returns all registered tool definitions
///
/// ## Type mapping (Rust ↔ TypeScript)
///
///   TS `ToolExecuteOptions`  →  Rust `JsExecuteOptions` (napi object)
///   TS `ToolExecuteResult`   →  Rust `JsExecuteResult`  (napi object)
///   TS `ToolDefinition`      →  Rust `JsToolDefinition` (napi object)
///   TS `Record<string, unknown>` → `serde_json::Value`
///
/// ## Thread safety
///
/// The global [`SdbGate`] is stored in a `OnceLock` and initialized once
/// on first call. All tool execution is synchronous (blocks the JS thread
/// for the duration of the tool call).

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

mod sdb;
mod snapshot;
mod tools;
mod utils;

use sdb::SdbGate;

// ============================================================================
// Global SdbGate singleton
// ============================================================================

static GATE: OnceLock<SdbGate> = OnceLock::new();

fn gate() -> &'static SdbGate {
    GATE.get_or_init(|| {
        let mut gate = SdbGate::new();
        gate.register_all();
        gate
    })
}

// ============================================================================
// napi object types — must mirror TypeScript interfaces exactly
// ============================================================================

/// Mirrors TypeScript `ToolExecuteOptions`.
/// Input to `execute()`.
#[napi(object)]
#[derive(Debug, Clone, Deserialize)]
pub struct JsExecuteOptions {
    /// Tool name, e.g. "file_read", "shell_bash".
    pub name: String,
    /// Tool arguments as a JSON value (parsed from JS object via serde-json).
    pub arguments: serde_json::Value,
    /// Project root directory (absolute path). Used as default for path-relative tools.
    pub project_path: Option<String>,
    /// Timeout in milliseconds (overrides tool default if > 0).
    pub timeout_ms: u32,
}

/// Mirrors TypeScript `ToolExecuteResult`.
/// Output from `execute()`.
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct JsExecuteResult {
    pub ok: bool,
    pub content: Option<String>,
    /// Structured error classification for Agent 4 reflection.
    /// This is the single source of truth — no redundant error_code string.
    /// Maps directly from the SDB step that failed:
    ///   Step 1 → "schema_invalid"    Step 2 → "permission_denied"
    ///   Step 4 → "timeout"           Step 5 → "diff_mismatch"
    ///   Step 6 → "test_failed"       Snapshot → "snapshot_failed"
    ///   Rollback → "rollback_failed"   other  → "execution_error"
    pub error_category: Option<String>,
    pub diff_summary: Option<String>,
    pub snapshot_id: Option<String>,
    /// Wall-clock execution time in milliseconds (captured by SDB gate).
    pub duration_ms: f64,
    // ── Step 6: Test Feedback fields ──
    /// Number of tests that passed (None = no tests were run).
    pub test_passed: Option<i32>,
    /// Number of tests that failed (None = no tests were run).
    pub test_failed: Option<i32>,
    /// First 2000 chars of test output for diagnostics (focused on FAIL entries).
    pub test_output: Option<String>,
    /// Path to the test file that was executed.
    pub test_file: Option<String>,
}

/// Mirrors TypeScript `ToolDefinition`.
/// Output from `list_tools()`.
#[napi(object)]
#[derive(Debug, Clone, Serialize)]
pub struct JsToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema object (serialized as JS object via serde-json).
    pub parameters: serde_json::Value,
    pub permission: String,
    pub timeout_ms: u32,
}

// ============================================================================
// napi exports — Contract B
// ============================================================================

/// Execute a tool through the SDB 6-step pipeline.
///
/// This is the main entry point for Agent 4. It runs:
///   1. Schema Validate
///   2. Permission Check
///   3. Pre-snapshot (if destructive + snapshot_enabled)
///   4. Execute (with timeout)
///   5. Diff Validate (if destructive)
///   6. Test Feedback (placeholder)
///
/// @contract Contract B: Agent 3 → Agent 4
#[napi]
pub fn execute(opts: JsExecuteOptions) -> JsExecuteResult {
    gate().execute(opts)
}

/// Rollback files to a previously captured snapshot.
///
/// @param snapshot_id  UUID returned by a previous `execute()` call.
/// @returns true if rollback succeeded, false if snapshot not found.
///
/// @contract Contract B: Agent 3 → Agent 4
#[napi]
pub fn rollback(snapshot_id: String) -> bool {
    gate().rollback(&snapshot_id)
}

/// Discard a snapshot without restoring files.
///
/// Used after a successful self-correct to clean up the original
/// (now-unnecessary) snapshot.
#[napi]
pub fn forget_snapshot(snapshot_id: String) -> bool {
    gate().forget_snapshot(&snapshot_id)
}

/// List all registered tool definitions.
///
/// The returned definitions must exactly match the tools available
/// via `execute()`. Every tool listed here is callable.
///
/// @contract Contract B: Agent 3 → Agent 4
#[napi]
pub fn list_tools() -> Vec<JsToolDefinition> {
    gate().cached_tools()
}

