//! The session index.
//!
//! Pi's RPC can switch to a session by path but cannot list them, so the rail
//! reads the store on disk directly: `~/.pi/agent/sessions/<encoded-cwd>/`,
//! one JSONL file per session.
//!
//! Reading is deliberately careful about cost. A busy session file is hundreds
//! of entries and there can be hundreds of files; parsing all of it to fill a
//! sidebar would be seconds of work for four fields. So each file is streamed
//! once, most lines are rejected by a substring test before any JSON parsing
//! happens, and the result is cached against the file's modification time —
//! rescanning an unchanged store costs a `stat` per file and nothing else.

use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionEntry {
    pub path: PathBuf,
    /// The display name, when one was set.
    pub name: String,
    /// The first thing the user asked, as a fallback title.
    pub first_message: String,
    pub messages: usize,
    pub modified: SystemTime,
    /// The workspace the session belongs to.
    pub cwd: String,
}

impl SessionEntry {
    /// What the rail shows as the row's title.
    pub fn title(&self) -> &str {
        if !self.name.is_empty() {
            &self.name
        } else if !self.first_message.is_empty() {
            &self.first_message
        } else {
            "Untitled session"
        }
    }
}

#[derive(Default)]
pub struct SessionIndex {
    cache: HashMap<PathBuf, (SystemTime, SessionEntry)>,
}

impl SessionIndex {
    /// Scan the store. `scope_cwd` limits the result to one workspace.
    pub fn scan(&mut self, scope_cwd: Option<&str>) -> Vec<SessionEntry> {
        let Some(root) = sessions_root() else {
            return Vec::new();
        };

        let mut out = Vec::new();
        let Ok(projects) = std::fs::read_dir(&root) else {
            return out;
        };

        for project in projects.flatten() {
            if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(modified) = file.metadata().and_then(|m| m.modified()) else {
                    continue;
                };

                // The cache turns a rescan into one `stat` per file.
                if let Some((seen, entry)) = self.cache.get(&path) {
                    if *seen == modified {
                        if matches_scope(entry, scope_cwd) {
                            out.push(entry.clone());
                        }
                        continue;
                    }
                }

                if let Some(entry) = read_session(&path, modified) {
                    self.cache.insert(path.clone(), (modified, entry.clone()));
                    if matches_scope(&entry, scope_cwd) {
                        out.push(entry);
                    }
                }
            }
        }

        // Most recently touched first: the session you want is almost always
        // the one you just left.
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        out
    }
}

fn matches_scope(entry: &SessionEntry, scope_cwd: Option<&str>) -> bool {
    scope_cwd.is_none_or(|cwd| entry.cwd == cwd)
}

fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join(".pi").join("agent").join("sessions"))
}

/// Stream one session file, extracting only the four fields the rail needs.
fn read_session(path: &Path, modified: SystemTime) -> Option<SessionEntry> {
    let file = File::open(path).ok()?;
    let reader = BufReader::with_capacity(64 * 1024, file);

    let mut name = String::new();
    let mut first_message = String::new();
    let mut messages = 0usize;
    let mut cwd = String::new();

    for line in reader.lines().map_while(Result::ok) {
        // Reject the overwhelming majority of lines without paying for a
        // parse: only a handful of entry types carry anything we want.
        let interesting = line.contains("\"message\"")
            || line.contains("\"session_info\"")
            || line.contains("\"cwd\"");
        if !interesting {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if cwd.is_empty() {
            if let Some(found) = value.get("cwd").and_then(Value::as_str) {
                cwd = found.to_string();
            }
        }

        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                if let Some(found) = value.get("name").and_then(Value::as_str) {
                    name = found.to_string();
                }
            }
            Some("message") => {
                let message = value.get("message");
                let role = message
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if role == "user" || role == "assistant" {
                    messages += 1;
                }
                if first_message.is_empty() && role == "user" {
                    if let Some(text) = message_text(message) {
                        first_message = text;
                    }
                }
            }
            _ => {}
        }
    }

    Some(SessionEntry {
        path: path.to_path_buf(),
        name,
        first_message,
        messages,
        modified,
        cwd,
    })
}

fn message_text(message: Option<&Value>) -> Option<String> {
    let content = message?.get("content")?;
    let raw = if let Some(text) = content.as_str() {
        text.to_string()
    } else {
        content
            .as_array()?
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    };

    let flattened = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!flattened.is_empty()).then(|| flattened.chars().take(160).collect())
}

/// "now", "12m", "3h", "5d" — the rail has width discipline.
pub fn relative(modified: SystemTime) -> String {
    let Ok(elapsed) = SystemTime::now().duration_since(modified) else {
        return "now".into();
    };
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        "now".into()
    } else if seconds < 3_600 {
        format!("{}m", seconds / 60)
    } else if seconds < 86_400 {
        format!("{}h", seconds / 3_600)
    } else {
        format!("{}d", seconds / 86_400)
    }
}
