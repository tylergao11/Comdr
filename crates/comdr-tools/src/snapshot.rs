/// FileSnapshot — copy-on-write backup system for destructive tool operations.
///
/// ## Purpose
///
/// Before a destructive tool (file_write, file_edit, git operations) executes,
/// the SDB Gate captures a snapshot of affected files. If the tool fails or
/// produces incorrect results (detected by Step 5-6), the snapshot can be
/// restored via `rollback()`.
///
/// ## Design
///
/// Each snapshot copies the original file contents into memory.
/// For large files (>10MB), only metadata is stored and the file is
/// backed up to a temp directory instead.
///
/// ## Thread safety
///
/// Snapshots are stored in a `Mutex<HashMap>` inside `SdbGate`.
/// A single snapshot is immutable after creation.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;
use std::time::SystemTime;

/// Maximum file size (bytes) to store in memory. Larger files go to temp dir.
const MAX_IN_MEMORY_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
/// Snapshot ID prefix length for temp filenames.
const SNAPSHOT_ID_PREFIX_LEN: usize = 8;

// ============================================================================
// FileSnapshot
// ============================================================================

/// A point-in-time backup of one or more files.
pub struct FileSnapshot {
    /// Unique identifier (UUID v4).
    pub id: String,
    /// Map of file path → original content (stored as bytes for fidelity).
    files: HashMap<String, SnapshotEntry>,
    /// Timestamp of capture (for future GC of old snapshots).
    #[allow(dead_code)]
    pub created_at: String,
}

enum SnapshotEntry {
    /// Small files: content in memory.
    InMemory(Vec<u8>),
    /// Large files: backed up to a temp file.
    OnDisk(std::path::PathBuf),
    /// File did not exist at snapshot time (creation was pending).
    DidNotExist,
}

impl FileSnapshot {
    /// Capture the current state of the given files.
    ///
    /// For files that exist: read their content into the snapshot.
    /// For files that don't exist: record as `DidNotExist` (so rollback deletes them).
    pub fn capture(files: &[String]) -> Result<Self, io::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut entries = HashMap::new();

        for path in files {
            let path = normalize_path(path);
            let p = Path::new(&path);

            let entry = if p.exists() {
                let metadata = fs::metadata(p)?;
                if metadata.len() > MAX_IN_MEMORY_SIZE {
                    // Large file: copy to temp dir
                    let temp_dir = std::env::temp_dir().join("comdr-snapshots");
                    fs::create_dir_all(&temp_dir)?;
                    let temp_file = temp_dir.join(format!("{}_{}", &id[..SNAPSHOT_ID_PREFIX_LEN], sanitize_filename(&path)));
                    fs::copy(p, &temp_file)?;
                    SnapshotEntry::OnDisk(temp_file)
                } else {
                    // Small file: keep in memory
                    let content = fs::read(p)?;
                    SnapshotEntry::InMemory(content)
                }
            } else {
                SnapshotEntry::DidNotExist
            };

            entries.insert(path, entry);
        }

        Ok(Self {
            id,
            files: entries,
            created_at: system_time_iso(),
        })
    }

    /// Restore all files to their original state.
    ///
    /// Uses atomic write-via-temp-then-rename to prevent corruption on crash.
    ///
    /// - `InMemory` entries: write to temp file, then rename to target.
    /// - `OnDisk` entries: copy to temp location, then rename to target.
    /// - `DidNotExist` entries: delete the file if it now exists.
    pub fn restore(&self) -> Result<(), io::Error> {
        for (path, entry) in &self.files {
            let p = Path::new(path);
            match entry {
                SnapshotEntry::InMemory(data) => {
                    // Ensure parent directory exists
                    if let Some(parent) = p.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    // Atomic write: data → temp file → rename to target
                    let tmp = tmp_path(p)?;
                    fs::write(&tmp, data)?;
                    fs::rename(&tmp, p)?;
                }
                SnapshotEntry::OnDisk(temp_path) => {
                    if let Some(parent) = p.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    // Copy to temp location first, then atomic rename
                    let tmp = tmp_path(p)?;
                    fs::copy(temp_path, &tmp)?;
                    fs::rename(&tmp, p)?;
                    // Best-effort: clean up temp file.
                    // Failure is acceptable — the temp file will be cleaned up
                    // by the OS temp-dir policy eventually.
                    if let Err(e) = fs::remove_file(temp_path) {
                        eprintln!("[snapshot] failed to remove temp file {:?}: {}", temp_path, e);
                    }
                }
                SnapshotEntry::DidNotExist => {
                    if p.exists() {
                        fs::remove_file(p)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Compute a unified diff between the snapshot and the current file state.
    ///
    /// Uses the `similar` crate for text diffing. Returns an empty string
    /// if no changes are detected.
    pub fn diff(&self) -> Result<String, io::Error> {
        let mut all_diffs = String::new();

        for (path, entry) in &self.files {
            let old_content = match entry {
                SnapshotEntry::InMemory(data) => {
                    String::from_utf8_lossy(data).to_string()
                }
                SnapshotEntry::OnDisk(temp_path) => {
                    fs::read_to_string(temp_path).unwrap_or_default()
                }
                SnapshotEntry::DidNotExist => String::new(),
            };

            let new_content = if Path::new(path).exists() {
                fs::read_to_string(path).unwrap_or_default()
            } else {
                String::new()
            };

            if old_content != new_content {
                let diff = similar::TextDiff::from_lines(&old_content, &new_content);
                let unified = diff.unified_diff();
                all_diffs.push_str(&format!("--- {}\n", path));
                all_diffs.push_str(&format!("+++ {} (current)\n", path));
                for change in unified.iter_hunks() {
                    all_diffs.push_str(&change.to_string());
                }
                all_diffs.push('\n');
            }
        }

        Ok(all_diffs)
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Normalize path to forward slashes.
use crate::utils::normalize_path;

/// Sanitize a filename for use in temp paths.
fn sanitize_filename(path: &str) -> String {
    path.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
}

/// ISO 8601 timestamp from SystemTime (replaces chrono dependency).
fn system_time_iso() -> String {
    match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => {
            let secs = d.as_secs();
            // Simple ISO 8601: YYYY-MM-DDTHH:MM:SSZ (close enough for snapshot tracking)
            let _days = secs / 86400;
            let time_secs = secs % 86400;
            let hours = time_secs / 3600;
            let mins = (time_secs % 3600) / 60;
            let secs_rem = time_secs % 60;
            // Days since Unix epoch → approximate date (good enough for GC ordering)
            format!(
                "unix_{}s_{:02}h{:02}m{:02}s",
                secs, hours, mins, secs_rem
            )
        }
        Err(_) => "unknown".to_string(),
    }
}

/// Generate a temp path next to the target file for atomic write-then-rename.
fn tmp_path(target: &Path) -> io::Result<std::path::PathBuf> {
    let parent = match target.parent() {
        Some(p) => p,
        None => return Err(io::Error::new(io::ErrorKind::InvalidInput, "cannot snapshot root path")),
    };
    let filename = target
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("tmp");
    let tmp_name = format!(".{}.tmp.{}", filename, uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0"));
    Ok(parent.join(tmp_name))
}
