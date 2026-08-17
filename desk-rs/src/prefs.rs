//! Preferences that outlive the process.
//!
//! Only choices the user made *deliberately* belong here. Window size is
//! restored by the platform, and anything derived from the session store is
//! cheaper to recompute than to invalidate — so this file stays small enough
//! that a corrupt one can simply be discarded rather than migrated.
//!
//! Writes are whole-file and best-effort. Losing a preference is a shrug;
//! blocking a click on a disk write, or panicking because a home directory is
//! read-only, is not.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// "workspace" or "all".
    pub rail_scope: String,
    /// "date", "project", or "none".
    pub rail_group_by: String,
    /// "recent", "name", or "length".
    pub rail_sort_by: String,
    /// Group keys the user has folded shut.
    pub collapsed_groups: Vec<String>,
}

impl Prefs {
    pub fn load() -> Self {
        let Some(path) = path() else {
            return Self::default();
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        // A file we cannot parse is a file from a future or broken version;
        // defaults are a better answer than refusing to start.
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn save(&self) {
        let Some(path) = path() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Mako")
            .join("prefs.json"),
    )
}
