/// Shell tool implementation — execute shell commands.
///
/// Cross-platform: uses `bash -c` on Unix, `cmd /c` on Windows.
/// Timeout is enforced via `wait_timeout` on the child process.

use std::sync::Arc;

use crate::tools::{Tool, ToolContext, ToolOutput, ToolPermission};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Polling interval in milliseconds for try_wait loop.
const POLL_INTERVAL_MS: u64 = 10;

/// Build and return the shell tool instance.
pub fn register_all(registry: &mut crate::tools::ToolRegistry) {
    registry.register(Arc::new(ShellBashTool));
}

// ============================================================================
// shell_bash
// ============================================================================

struct ShellBashTool;

impl Tool for ShellBashTool {
    fn name(&self) -> &str {
        "shell_bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command. On Unix uses bash, on Windows uses cmd."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute"
                },
                "cwd": {
                    "type": "string",
                    "description": "Working directory for the command"
                },
                "env": {
                    "type": "object",
                    "description": "Additional environment variables"
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "Timeout in milliseconds"
                }
            },
            "required": ["command"]
        })
    }

    fn permission(&self) -> ToolPermission {
        // shell_bash is destructive by default — it can modify the system
        ToolPermission::RequiresApproval
    }

    fn timeout_ms(&self) -> u32 {
        120_000 // 2 minutes default
    }

    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutput {
        let command_str = match args.get("command").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => {
                return ToolOutput::err("shell_bash", "SCHEMA_INVALID", &[], None)
            }
        };

        let cwd = args
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| ctx.project_path.clone());

        let timeout_ms = args
            .get("timeout_ms")
            .and_then(|v| v.as_f64())
            .map(|n| n as u32)
            .unwrap_or_else(|| self.timeout_ms());

        // Choose shell based on platform
        let (shell, shell_arg) = if cfg!(target_os = "windows") {
            ("cmd", "/c")
        } else {
            ("bash", "-c")
        };

        let mut cmd = Command::new(shell);
        cmd.arg(shell_arg)
            .arg(command_str)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Add extra environment variables if provided
        if let Some(env) = args.get("env").and_then(|v| v.as_object()) {
            for (key, val) in env {
                if let Some(v) = val.as_str() {
                    cmd.env(key, v);
                }
            }
        }

        // Spawn the child process
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return ToolOutput::error(
                    "EXECUTION_FAILED",
                    format!("Failed to spawn process: {}", e),
                )
            }
        };

        // Wait with timeout using try_wait polling
        let timeout = Duration::from_millis(timeout_ms as u64);
        let start = Instant::now();

        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if start.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait(); // Reap the zombie
                        return ToolOutput::error(
                            "TIMEOUT",
                            format!(
                                "Command timed out after {}ms: {}",
                                timeout_ms, command_str
                            ),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                }
                Err(e) => {
                    return ToolOutput::error(
                        "EXECUTION_FAILED",
                        format!("Failed to wait on process: {}", e),
                    );
                }
            }
        };

        // Collect output after the process has exited
        let mut stdout_str = String::new();
        let mut stderr_str = String::new();

        if let Some(ref mut stdout) = child.stdout {
            let _ = stdout.read_to_string(&mut stdout_str);
        }
        if let Some(ref mut stderr) = child.stderr {
            let _ = stderr.read_to_string(&mut stderr_str);
        }

        let exit_code = exit_status.and_then(|s| s.code()).unwrap_or(-1);

        let mut result = String::new();
        result.push_str(&format!("Exit code: {}\n", exit_code));

        if !stdout_str.is_empty() {
            result.push_str(&format!("\n[stdout]\n{}\n", stdout_str));
        }
        if !stderr_str.is_empty() {
            result.push_str(&format!("\n[stderr]\n{}\n", stderr_str));
        }

        if exit_code != 0 {
            ToolOutput {
                ok: false,
                content: Some(result),
                error_code: Some("EXECUTION_FAILED".to_string()),
            }
        } else {
            ToolOutput::ok("shell_bash", &[("exit_code", &exit_code.to_string())], Some(&result))
        }
    }
}
