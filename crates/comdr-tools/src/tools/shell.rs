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

        // ★ 安全检查：拒绝含明显注入模式的命令
        //   shell_bash 是工具链中最强大的工具，用户确认后才执行。
        //   此检查作为 defense-in-depth，不替代 Agent 4 的权限关口。
        if has_command_injection_risk(command_str) {
            return ToolOutput::error(
                "COMMAND_INJECTION_RISK",
                "Command contains potentially dangerous patterns. ",
            );
        }

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
                        // Best-effort: kill the timed-out child process and reap it.
                        // Both are necessary to prevent zombies; failure is rare and
                        // has no actionable recourse.
                        if let Err(e) = child.kill() {
                            eprintln!("[shell] failed to kill timed-out process: {}", e);
                        }
                        if let Err(e) = child.wait() {
                            eprintln!("[shell] failed to reap timed-out process: {}", e);
                        }
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
            if let Err(e) = stdout.read_to_string(&mut stdout_str) {
                eprintln!("[shell] read stdout error: {}", e);
            }
        }
        if let Some(ref mut stderr) = child.stderr {
            if let Err(e) = stderr.read_to_string(&mut stderr_str) {
                eprintln!("[shell] read stderr error: {}", e);
            }
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

// ============================================================================
// Defense-in-depth: command injection risk detection
// ============================================================================

/// Check for obvious shell injection / destructive command patterns.
///
/// This is NOT a security boundary — the real protection is Agent 4's
/// `RequiresApproval` permission gate. This function catches the most
/// obvious attacks (rm -rf /, fork bombs, pipe-to-shell) as defense-in-depth.
fn has_command_injection_risk(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();

    // Patterns that are almost certainly destructive / malicious
    let dangerous_patterns = [
        // Fork bomb
        ":(){ :|:& };:",
        // Recursive force delete from root
        "rm -rf /",
        "rm -rf ~",
        "rm -fr /",
        // Format / wipe filesystem
        "mkfs.",
        "dd if=/dev/zero",
        "dd if=/dev/urandom",
        // Fork bomb variants
        "%0|%0",
        // Shell exec of self
        "$0 &",
        // Write directly to block devices
        "> /dev/sd",
        "> /dev/hd",
        "> /dev/nvme",
    ];

    for pattern in &dangerous_patterns {
        if lower.contains(pattern) {
            return true;
        }
    }

    // Reject commands with suspicious semicolon-chaining of destructive ops
    if lower.contains(';') {
        let parts: Vec<&str> = cmd.split(';').collect();
        let mut has_destructive = false;
        let destructive_commands = [
            "rm ", "shutdown", "reboot", "mkfs", "dd ", "format",
            "fdisk", "del /f", "rd /s", "format c:",
        ];
        for part in &parts {
            let p = part.trim().to_lowercase();
            for dc in &destructive_commands {
                if p.starts_with(dc) {
                    has_destructive = true;
                    break;
                }
            }
        }
        if has_destructive && parts.len() >= 2 {
            return true; // Multiple chained commands with destructive ops
        }
    }

    false
}
