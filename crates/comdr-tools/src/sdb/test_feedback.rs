/// Test Feedback — SDB Step 6: auto-discover and run affected tests.
///
/// ## Strategy (convention-over-configuration)
///
/// 1. Map modified source files to test files via common conventions
/// 2. Detect the project's test runner from config files
/// 3. Execute the scoped test command
/// 4. Parse pass/fail counts from output
///
/// Falls back gracefully: no test file found → Skipped (not an error).
/// Only runs tests for `file_write`, `file_edit`, and `file_delete` operations.

use std::path::Path;
use std::process::Command;

// ============================================================================
// §1 TestFeedbackResult
// ============================================================================

/// Result of attempting to run tests after a tool execution.
#[derive(Debug, Clone)]
pub enum TestFeedbackResult {
    /// No test file could be found for the modified files — skipped.
    Skipped,
    /// Tests ran and all passed.
    Passed {
        passed: usize,
        test_file: String,
    },
    /// Tests ran and some failed.
    Failed {
        passed: usize,
        failed: usize,
        test_file: String,
        /// First 2000 chars of test output for diagnostics.
        output: String,
    },
    /// Test runner was found but execution failed (exit code ≠ 0, no parseable results).
    ExecutionError {
        message: String,
    },
}

// ============================================================================
// §2 TestFilePattern
// ============================================================================

/// Convention patterns for mapping source files → test files.
struct TestPattern {
    /// Glob-like: `{stem}` = filename without ext, `{ext}` = file extension,
    /// `{dirname}` = parent directory name, `{path_no_ext}` = path without extension.
    transform: fn(source: &Path) -> Option<String>,
}

/// Try to find a test file for a given source file path.
fn discover_test_file(source_path: &str, project_root: &str) -> Option<String> {
    let source = Path::new(source_path);
    let patterns: &[TestPattern] = &[
        // ── TypeScript/JavaScript (Jest, Vitest, Mocha) ──
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent = s.parent()?.to_str()?;
                // Jest/Vitest: tests/<path>/<file>.test.<ext>
                let ext = s.extension().and_then(|e| e.to_str()).unwrap_or("ts");
                Some(format!("tests/{}/{}.test.{}", parent, stem, ext))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent = s.parent()?;
                // Jest inline: <path>/__tests__/<file>.test.<ext>
                let ext = s.extension().and_then(|e| e.to_str()).unwrap_or("ts");
                let parent_str = parent.to_str()?;
                Some(format!("{}/__tests__/{}.test.{}", parent_str, stem, ext))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent = s.parent()?.to_str()?;
                // Co-located: <path>/<file>.test.<ext>
                let ext = s.extension().and_then(|e| e.to_str()).unwrap_or("ts");
                Some(format!("{}/{}.test.{}", parent, stem, ext))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent = s.parent()?.to_str()?;
                // Angular/Jasmine: <path>/<file>.spec.<ext>
                let ext = s.extension().and_then(|e| e.to_str()).unwrap_or("ts");
                Some(format!("{}/{}.spec.{}", parent, stem, ext))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent = s.parent()?.to_str()?;
                // Go: <path>/<file>_test.go (only for .go files)
                if s.extension().and_then(|e| e.to_str()) == Some("go") {
                    Some(format!("{}/{}_test.go", parent, stem))
                } else {
                    None
                }
            },
        },
        // ── Rust ──
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                // Rust integration test: tests/<stem>_test.rs (convention)
                if s.extension().and_then(|e| e.to_str()) == Some("rs") {
                    Some(format!("tests/{}_test.rs", stem))
                } else {
                    None
                }
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent_dir = s.parent()?.file_name()?.to_str()?;
                // Rust module test: tests/<parent>_test.rs
                if s.extension().and_then(|e| e.to_str()) == Some("rs") {
                    Some(format!("tests/{}_{}_test.rs", parent_dir, stem))
                } else {
                    None
                }
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                let parent_dir = s.parent()?.file_name()?.to_str()?;
                // Python: tests/test_<module>_<file>.py
                Some(format!("tests/test_{}_{}.py", parent_dir, stem))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                // Python flat: tests/test_<file>.py
                Some(format!("tests/test_{}.py", stem))
            },
        },
        TestPattern {
            transform: |s| {
                let stem = s.file_stem()?.to_str()?;
                // Ruby: spec/<file>_spec.rb
                Some(format!("spec/{}_spec.rb", stem))
            },
        },
    ];

    for pattern in patterns {
        if let Some(candidate) = (pattern.transform)(source) {
            let full = Path::new(project_root).join(&candidate);
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }

    None
}

// ============================================================================
// §3 Test Runner Detection
// ============================================================================

/// Detected test runner info.
#[derive(Debug, Clone)]
struct TestRunner {
    /// Shell command to run a single test file, with `{file}` as placeholder.
    /// e.g. "npx vitest run {file}" or "cargo test -- {module}"
    command_template: String,
    /// Whether the command prefers the file path or module name.
    use_module_name: bool,
}

/// Detect the test runner for a project.
fn detect_runner(project_root: &str, source_path: &str) -> Option<TestRunner> {
    let root = Path::new(project_root);

    // ── Rust project ──
    if root.join("Cargo.toml").exists() {
        // Convert path like "src/auth/service.rs" → "auth::service"
        let module = file_path_to_rust_module(source_path);
        return Some(TestRunner {
            command_template: format!("cargo test -- {} --nocapture 2>&1", module),
            use_module_name: true,
        });
    }

    // ── Go project ──
    if root.join("go.mod").exists() {
        let pkg_dir = Path::new(source_path).parent()?.to_str()?;
        return Some(TestRunner {
            command_template: format!("go test ./{} -run . -count=1 2>&1", pkg_dir),
            use_module_name: false,
        });
    }

    // ── Node.js project ──
    if root.join("package.json").exists() {
        let pkg_json = std::fs::read_to_string(root.join("package.json")).ok()?;
        let _pkg: serde_json::Value = serde_json::from_str(&pkg_json).ok()?;

        // Check for vitest first (most modern)
        if pkg_json.contains("\"vitest\"") {
            return Some(TestRunner {
                command_template: "npx vitest run {file} --reporter=verbose 2>&1".to_string(),
                use_module_name: false,
            });
        }
        // Then jest
        if pkg_json.contains("\"jest\"") {
            return Some(TestRunner {
                command_template: "npx jest {file} --verbose 2>&1".to_string(),
                use_module_name: false,
            });
        }
        // Then mocha
        if pkg_json.contains("\"mocha\"") {
            return Some(TestRunner {
                command_template: "npx mocha {file} 2>&1".to_string(),
                use_module_name: false,
            });
        }
        // Fallback: use whatever `npm test` runs, scoped by pattern
        // Don't run `npm test` with no args — that would run ALL tests
        return None;
    }

    // ── Python project ──
    if root.join("pyproject.toml").exists() || root.join("setup.cfg").exists()
        || root.join("setup.py").exists()
    {
        return Some(TestRunner {
            command_template: "python -m pytest {file} -v 2>&1".to_string(),
            use_module_name: false,
        });
    }

    // ── Ruby project (Gemfile) ──
    if root.join("Gemfile").exists() {
        return Some(TestRunner {
            command_template: "bundle exec rspec {file} --format progress 2>&1".to_string(),
            use_module_name: false,
        });
    }

    None
}

/// Convert a file path to a Rust module path.
/// "src/auth/service.rs" → "auth::service"
fn file_path_to_rust_module(path: &str) -> String {
    let p = path
        .trim_start_matches("src/")
        .trim_end_matches(".rs")
        .replace('/', "::");
    // Filter out main/lib/mod — these are entry points, not testable modules
    p.replace("::mod", "")
        .replace("main", "")
        .trim_matches(':')
        .to_string()
}

// ============================================================================
// §4 Test Execution & Result Parsing
// ============================================================================

/// Execute the test runner for a specific test file and parse results.
///
/// Uses `wait_timeout` with a 90s cap to prevent infinite hangs.
/// Test runners also have their own internal timeouts (Jest: 5s/test, Cargo: 60s).
fn run_test(
    runner: &TestRunner,
    test_file: &str,
    project_root: &str,
) -> TestFeedbackResult {
    let cmd_str = if runner.use_module_name {
        // Rust: `cargo test -- <module>`
        runner.command_template.clone()
    } else {
        // Node/Python/Go: replace {file} placeholder
        runner.command_template.replace("{file}", test_file)
    };

    // Choose shell based on platform
    let (shell, shell_arg) = if cfg!(target_os = "windows") {
        ("cmd", "/c")
    } else {
        ("bash", "-c")
    };

    let mut cmd = Command::new(shell);
    cmd.arg(shell_arg)
        .arg(&cmd_str)
        .current_dir(project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return TestFeedbackResult::ExecutionError {
                message: format!("Failed to spawn test runner: {}", e),
            };
        }
    };

    // Wait with timeout via try_wait polling (same pattern as shell.rs).
    // 90s timeout: generous for scoped tests, bounded against hangs.
    let timeout = std::time::Duration::from_secs(90);
    let start = std::time::Instant::now();
    let poll_interval = std::time::Duration::from_millis(50);

    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return TestFeedbackResult::ExecutionError {
                        message: "Test runner timed out after 90s".to_string(),
                    };
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                return TestFeedbackResult::ExecutionError {
                    message: format!("Failed to wait on test runner: {}", e),
                };
            }
        }
    };

    // Collect output
    let stdout = child.stdout.as_mut()
        .map(|s| { let mut buf = String::new(); let _ = std::io::Read::read_to_string(s, &mut buf); buf })
        .unwrap_or_default();
    let stderr = child.stderr.as_mut()
        .map(|s| { let mut buf = String::new(); let _ = std::io::Read::read_to_string(s, &mut buf); buf })
        .unwrap_or_default();
    let combined = format!("{}\n{}", stdout, stderr);

    let parsed = parse_test_output(&combined);
    if parsed.total == 0 {
        return TestFeedbackResult::ExecutionError {
            message: format!(
                "Test runner output could not be parsed (exit: {:?}). First 500 chars: {}",
                exit_status.and_then(|s| s.code()),
                &combined[..combined.len().min(500)]
            ),
        };
    }

    if parsed.failed > 0 {
        TestFeedbackResult::Failed {
            passed: parsed.passed,
            failed: parsed.failed,
            test_file: test_file.to_string(),
            output: combined[..combined.len().min(2000)].to_string(),
        }
    } else {
        TestFeedbackResult::Passed {
            passed: parsed.passed,
            test_file: test_file.to_string(),
        }
    }
}

/// Parsed test result counts.
struct ParsedResults {
    passed: usize,
    failed: usize,
    total: usize,
}

/// Parse test output to extract pass/fail counts.
///
/// Supports common formats:
///   - "3/12 tests passed" / "3/12 tests failed" (Jest, Vitest)
///   - "Tests: 3 passed, 12 total" (Jest verbose)
///   - "3 passing (12ms)" / "3 passing (12)" (Mocha)
///   - "test result: ok. 3 passed; 0 failed" (Cargo test)
///   - "3 passed, 1 failed" / "FAILED (failures=1)" (pytest)
///   - "FAIL 3 of 12" (Go test)
fn parse_test_output(output: &str) -> ParsedResults {
    // ── Pattern 1: "N/M tests passed" / "N/M tests failed" (Jest, Vitest) ──
    if let Some(caps) = parse_jest_vitest(output) {
        return caps;
    }

    // ── Pattern 2: "Tests: N passed, M total" (Jest --verbose) ──
    if let Some(caps) = parse_jest_verbose(output) {
        return caps;
    }

    // ── Pattern 3: "N passing" / "N failing" (Mocha) ──
    if let Some(caps) = parse_mocha(output) {
        return caps;
    }

    // ── Pattern 4: "test result: ok. N passed; M failed" (Cargo test) ──
    if let Some(caps) = parse_cargo(output) {
        return caps;
    }

    // ── Pattern 5: "N passed, M failed" (pytest) ──
    if let Some(caps) = parse_pytest(output) {
        return caps;
    }

    // ── Pattern 6: "FAIL N of M" (Go test when failing) ──
    if let Some(caps) = parse_go_test(output) {
        return caps;
    }

    // ── Fallback: count "PASS" and "FAIL" lines ──
    parse_pass_fail_lines(output)
}

fn parse_jest_vitest(output: &str) -> Option<ParsedResults> {
    // "Tests: 3/12 passed" or "Tests: 1 failed, 11 passed, 12 total"
    let re = regex::Regex::new(r"Tests:\s*(?:(\d+)\s*/\s*(\d+)\s*(?:passed|failed))")
        .ok()?;
    let caps = re.captures(output)?;
    let n = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let total = caps.get(2)?.as_str().parse::<usize>().ok()?;

    // Determine if N was passed or failed count
    let (passed, failed) = if output.contains("failed") {
        (total.saturating_sub(n), n)
    } else {
        (n, total.saturating_sub(n))
    };
    Some(ParsedResults { passed, failed, total })
}

fn parse_jest_verbose(output: &str) -> Option<ParsedResults> {
    let re = regex::Regex::new(r"Tests:\s*(\d+)\s*passed,\s*(\d+)\s*total").ok()?;
    let caps = re.captures(output)?;
    let passed = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let total = caps.get(2)?.as_str().parse::<usize>().ok()?;
    let failed = total.saturating_sub(passed);
    Some(ParsedResults { passed, failed, total })
}

fn parse_mocha(output: &str) -> Option<ParsedResults> {
    let re_passing = regex::Regex::new(r"(\d+)\s*passing").ok()?;
    let re_failing = regex::Regex::new(r"(\d+)\s*failing").ok()?;

    let passed = re_passing
        .captures(output)
        .and_then(|c| c.get(1)?.as_str().parse::<usize>().ok());
    let failed = re_failing
        .captures(output)
        .and_then(|c| c.get(1)?.as_str().parse::<usize>().ok());

    match (passed, failed) {
        (Some(p), Some(f)) => Some(ParsedResults { passed: p, failed: f, total: p + f }),
        (Some(p), None) => Some(ParsedResults { passed: p, failed: 0, total: p }),
        _ => None,
    }
}

fn parse_cargo(output: &str) -> Option<ParsedResults> {
    // "test result: ok. 3 passed; 0 failed; 0 ignored"
    let re = regex::Regex::new(r"test result: \w+\. (\d+) passed; (\d+) failed").ok()?;
    let caps = re.captures(output)?;
    let passed = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let failed = caps.get(2)?.as_str().parse::<usize>().ok()?;
    Some(ParsedResults { passed, failed, total: passed + failed })
}

fn parse_pytest(output: &str) -> Option<ParsedResults> {
    // "3 passed, 1 failed" or "3 passed"
    let re = regex::Regex::new(r"(\d+)\s*passed(?:,\s*(\d+)\s*failed)?").ok()?;
    let caps = re.captures(output)?;
    let passed = caps.get(1)?.as_str().parse::<usize>().ok()?;
    let failed = caps
        .get(2)
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(0);
    // Also try "FAILED (failures=N)" pattern
    let re_failures = regex::Regex::new(r"FAILED.*failures=(\d+)").ok();
    let failed2 = re_failures
        .and_then(|r| r.captures(output))
        .and_then(|c| c.get(1)?.as_str().parse::<usize>().ok())
        .unwrap_or(0);
    let f = failed.max(failed2);
    Some(ParsedResults { passed, failed: f, total: passed + f })
}

fn parse_go_test(output: &str) -> Option<ParsedResults> {
    // "FAIL N of M" or "ok  <pkg>  0.123s" (all passed = ok)
    if output.contains("ok  ") && !output.contains("FAIL") {
        return Some(ParsedResults { passed: 1, failed: 0, total: 1 });
    }
    let re = regex::Regex::new(r"FAIL\s+\d+\s+of\s+(\d+)").ok()?;
    let caps = re.captures(output)?;
    let total = caps.get(1)?.as_str().parse::<usize>().ok()?;
    // Also check for individual "--- FAIL" and "--- PASS" lines
    let re_pass = regex::Regex::new(r"--- PASS:").ok()?;
    let re_fail = regex::Regex::new(r"--- FAIL:").ok()?;
    let pass_count = re_pass.find_iter(output).count();
    let fail_count = re_fail.find_iter(output).count();
    let p = pass_count.max(0);
    let f = fail_count.max(total.saturating_sub(pass_count));
    Some(ParsedResults { passed: p, failed: f, total: p + f })
}

fn parse_pass_fail_lines(output: &str) -> ParsedResults {
    let re_pass = regex::Regex::new(r"^\s*(?:✓|✔|PASS|ok)\s").ok();
    let re_fail = regex::Regex::new(r"^\s*(?:✗|✘|✕|FAIL)\s").ok();

    let pass_count = re_pass
        .as_ref()
        .map(|r| r.find_iter(output).count())
        .unwrap_or(0);
    let fail_count = re_fail
        .as_ref()
        .map(|r| r.find_iter(output).count())
        .unwrap_or(0);

    if pass_count == 0 && fail_count == 0 {
        return ParsedResults { passed: 0, failed: 0, total: 0 };
    }
    ParsedResults { passed: pass_count, failed: fail_count, total: pass_count + fail_count }
}

// ============================================================================
// §5 Public API
// ============================================================================

/// Run Step 6: discover and execute affected tests for a file modification.
///
/// Only triggers for destructive tools (file_write, file_edit, file_delete).
///
/// Returns `TestFeedbackResult::Skipped` when:
///   - The tool is not destructive (read-only operations don't need test feedback)
///   - No test file could be discovered
///   - No test runner could be detected
pub fn run_test_feedback(
    tool_name: &str,
    source_path: &str,
    project_root: &str,
) -> TestFeedbackResult {
    // Only run tests for destructive file operations
    if !matches!(tool_name, "file_write" | "file_edit" | "file_delete") {
        return TestFeedbackResult::Skipped;
    }

    // Step 6a: Discover test file
    let test_file = match discover_test_file(source_path, project_root) {
        Some(f) => f,
        None => return TestFeedbackResult::Skipped,
    };

    // Step 6b: Detect test runner
    let runner = match detect_runner(project_root, source_path) {
        Some(r) => r,
        None => return TestFeedbackResult::Skipped,
    };

    // Step 6c: Execute test
    run_test(&runner, &test_file, project_root)
}
