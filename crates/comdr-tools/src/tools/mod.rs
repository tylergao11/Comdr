/// Tool trait + ToolRegistry — the plugin system for all tool implementations.
///
/// Each tool category (file, shell, git, lsp) implements the [`Tool`] trait
/// and registers itself in the [`ToolRegistry`]. The registry dispatches
/// by tool name (e.g. "file_read", "shell_bash").
///
/// ## Naming convention
///   - Tool names: lowercase with underscores  →  `file_read`, `shell_bash`
///   - Each tool = one atomic operation. Groups share a module but register individually.

pub mod file;
pub mod git;
pub mod lsp;
pub mod shell;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

// ============================================================================
// ToolPermission
// ============================================================================

/// Mirrors the TypeScript `ToolPermission` union type.
/// Serialized as lowercase snake_case strings to match TS constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPermission {
    ReadOnly,
    Destructive,
    RequiresApproval,
}

// ============================================================================
// ToolContext
// ============================================================================

/// Context passed to every tool execution.
pub struct ToolContext {
    /// Project root directory (absolute path with forward slashes).
    pub project_path: String,
}

// ============================================================================
// ToolOutput
// ============================================================================

/// Return type of [`Tool::execute`].
/// Mirrors the TypeScript `ToolExecuteResult` (without diffSummary/snapshotId
/// — those are added by the SDB pipeline layer).
#[derive(Debug, Serialize)]
pub struct ToolOutput {
    pub ok: bool,
    pub content: Option<String>,
    pub error_code: Option<String>,
}

impl ToolOutput {
    /// Legacy — kept for internal use where structured format isn't needed.
    pub fn success(content: impl Into<String>) -> Self {
        Self { ok: true, content: Some(content.into()), error_code: None }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { ok: false, content: Some(message.into()), error_code: Some(code.into()) }
    }

    /// ★ Unified success format: [OK] tool_name k=v k=v
    pub fn ok(tool: &str, pairs: &[(&str, &str)], detail: Option<&str>) -> Self {
        let mut s = format!("[OK] {}", tool);
        for (k, v) in pairs {
            s.push(' ');
            s.push_str(k);
            s.push('=');
            s.push_str(v);
        }
        if let Some(d) = detail {
            s.push('\n');
            s.push_str(d);
        }
        Self { ok: true, content: Some(s), error_code: None }
    }

    /// ★ Unified error format: [ERR] tool_name k=v error=msg
    pub fn err(tool: &str, error_code: &str, pairs: &[(&str, &str)], detail: Option<&str>) -> Self {
        let mut s = format!("[ERR] {} error={}", tool, error_code);
        for (k, v) in pairs {
            s.push(' ');
            s.push_str(k);
            s.push('=');
            s.push_str(v);
        }
        if let Some(d) = detail {
            s.push('\n');
            s.push_str(d);
        }
        Self { ok: false, content: Some(s), error_code: Some(error_code.to_string()) }
    }

    /// ★ Blueprint error: structured diagnostic with type, location, cause, hint
    pub fn blueprint_err(tool: &str, error_code: &str, location: &str, cause: &str, hint: &str) -> Self {
        let s = format!(
            "[ERR] {} error={} location={} cause={} hint={}",
            tool, error_code, location, cause, hint
        );
        Self { ok: false, content: Some(s), error_code: Some(error_code.to_string()) }
    }
}

// ============================================================================
// Tool trait
// ============================================================================

/// Every tool command implements this trait.
///
/// # Safety
/// Must be `Send + Sync` because the registry is shared across threads
/// (napi calls may come from different JS threads).
pub trait Tool: Send + Sync {
    /// Unique name, e.g. `"file_read"`, `"shell_bash"`.
    fn name(&self) -> &str;

    /// Human-readable one-line description.
    fn description(&self) -> &str;

    /// JSON Schema for the arguments object.
    fn parameters(&self) -> Value;

    /// Permission level for this tool.
    fn permission(&self) -> ToolPermission;

    /// Default timeout in milliseconds. 0 = no limit.
    fn timeout_ms(&self) -> u32;

    /// Execute the tool with parsed arguments.
    ///
    /// `args` is the already-validated JSON arguments object.
    /// Returns `ToolOutput` — the SDB layer wraps this with diff/snapshot data.
    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput;
}

// ============================================================================
// ToolRegistry
// ============================================================================

/// Registry of all available tools, keyed by tool name.
///
/// ## Usage
/// ```ignore
/// let mut registry = ToolRegistry::new();
/// registry.register(Arc::new(FileReadTool));
/// let output = registry.execute("file_read", &args, &ctx);
/// ```
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool. Panics if a tool with the same name is already registered.
    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        if self.tools.contains_key(&name) {
            panic!("ToolRegistry: duplicate tool name '{}'", name);
        }
        self.tools.insert(name, tool);
    }

    /// Look up a tool by name. Returns a cloned Arc for thread-safe sharing.
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// List all registered tool definitions (for the `list_tools()` napi export).
    pub fn list_definitions(&self) -> Vec<ToolDefinitionEntry> {
        self.tools
            .iter()
            .map(|(name, tool)| ToolDefinitionEntry {
                name: name.clone(),
                description: tool.description().to_string(),
                parameters: tool.parameters(),
                permission: tool.permission(),
                timeout_ms: tool.timeout_ms(),
            })
            .collect()
    }

    /// Execute a tool by name directly (bypasses SDB pipeline). Used for testing.
    #[allow(dead_code)]
    pub fn execute(&self, name: &str, args: &Value, ctx: &ToolContext) -> ToolOutput {
        match self.tools.get(name) {
            Some(tool) => tool.execute(args, ctx),
            None => ToolOutput::error(
                "EXECUTION_FAILED",
                format!("Unknown tool: '{}'", name),
            ),
        }
    }
}

// ============================================================================
// ToolDefinitionEntry (for list_tools export)
// ============================================================================

/// Flat struct matching the TypeScript `ToolDefinition` interface.
/// Returned by `list_tools()` for the napi boundary.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinitionEntry {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub permission: ToolPermission,
    pub timeout_ms: u32,
}
