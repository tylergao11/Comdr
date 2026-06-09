/// Shared utility functions used across the comdr-tools crate.

/// Normalize path separators to forward slashes (cross-platform).
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}
