/// Shared utility functions used across the comdr-tools crate.

/// Normalize path separators to forward slashes (cross-platform).
///
/// Also strips the Windows `\\?\` long-path prefix so the rest of the
/// codebase sees clean forward-slash paths.
pub fn normalize_path(path: &str) -> String {
    let s = path.replace('\\', "/");
    // Strip Windows long-path prefix \\?\
    if s.starts_with("//?/") {
        s[4..].to_string()
    } else {
        s
    }
}
