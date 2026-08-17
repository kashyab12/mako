//! Git, read directly.
//!
//! The agent has no opinion about the working tree, so this talks to `git`
//! itself rather than going through Pi. Every call is a subprocess, which is
//! cheap for status and expensive for a full diff — so status is polled and
//! file contents are fetched only when a file is opened.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

impl FileStatus {
    /// The single letter shown on the row.
    pub fn glyph(self) -> &'static str {
        match self {
            FileStatus::Added => "A",
            FileStatus::Modified => "M",
            FileStatus::Deleted => "D",
            FileStatus::Renamed => "R",
            FileStatus::Untracked => "U",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub staged: bool,
}

#[derive(Debug, Clone, Default)]
pub struct GitStatus {
    pub root: Option<PathBuf>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangedFile>,
}

impl GitStatus {
    pub fn insertions(&self) -> u32 {
        self.files.iter().map(|f| f.insertions).sum()
    }

    pub fn deletions(&self) -> u32 {
        self.files.iter().map(|f| f.deletions).sum()
    }

    pub fn staged(&self) -> usize {
        self.files.iter().filter(|f| f.staged).count()
    }
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).current_dir(root).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn find_root(cwd: &str) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    output.status.success().then(|| {
        PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
}

/// Read the working tree. Two subprocesses, no file contents.
pub fn status(cwd: &str) -> GitStatus {
    let Some(root) = find_root(cwd) else {
        return GitStatus::default();
    };

    let porcelain = git(
        &root,
        &["status", "--porcelain=v1", "-b", "--untracked-files=all"],
    )
    .unwrap_or_default();

    // `--numstat` gives per-file line counts without the patch bodies, which
    // is the difference between a few kilobytes and a few megabytes.
    let numstat = git(&root, &["diff", "--numstat", "HEAD"]).unwrap_or_default();
    let cached = git(&root, &["diff", "--numstat", "--cached"]).unwrap_or_default();

    let mut stats = parse_numstat(&numstat);
    for (path, value) in parse_numstat(&cached) {
        stats.entry(path).or_insert(value);
    }

    let mut out = GitStatus {
        root: Some(root),
        ..Default::default()
    };

    for line in porcelain.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            out.branch = header
                .split(['.', ' '])
                .next()
                .unwrap_or_default()
                .to_string();
            out.ahead = capture(header, "ahead ");
            out.behind = capture(header, "behind ");
            continue;
        }
        if line.len() < 4 {
            continue;
        }

        let xy = &line[0..2];
        let path = line[3..].to_string();
        // A rename reads `old -> new`; the new name is what the row shows.
        let path = path
            .split_once(" -> ")
            .map(|(_, new)| new.to_string())
            .unwrap_or(path);

        let status = if xy == "??" {
            FileStatus::Untracked
        } else if xy.contains('R') {
            FileStatus::Renamed
        } else if xy.contains('D') {
            FileStatus::Deleted
        } else if xy.contains('A') {
            FileStatus::Added
        } else {
            FileStatus::Modified
        };

        let (insertions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        out.files.push(ChangedFile {
            staged: !xy.starts_with(' ') && !xy.starts_with('?'),
            path,
            status,
            insertions,
            deletions,
        });
    }

    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The patch for one file, fetched only when it is opened.
pub fn diff(root: &Path, path: &str) -> String {
    // A file with no HEAD entry is new, so fall back to showing its contents
    // as an addition rather than an empty diff.
    git(root, &["diff", "HEAD", "--", path])
        .filter(|patch| !patch.trim().is_empty())
        .or_else(|| git(root, &["diff", "--cached", "--", path]))
        .filter(|patch| !patch.trim().is_empty())
        .or_else(|| std::fs::read_to_string(root.join(path)).ok())
        .unwrap_or_default()
}

pub fn stage(root: &Path, paths: &[String]) {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    let _ = git(root, &args);
}

pub fn unstage(root: &Path, paths: &[String]) {
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    let _ = git(root, &args);
}

pub fn commit(root: &Path, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(root)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[derive(Debug, Clone)]
pub struct Commit {
    pub short: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

pub fn log(root: &Path, limit: usize) -> Vec<Commit> {
    // A unit separator keeps subjects containing punctuation intact.
    let format = format!("--pretty=format:%h\x1f%s\x1f%an\x1f%ar");
    let out = git(root, &[
        "log",
        &format!("--max-count={limit}"),
        &format,
    ])
    .unwrap_or_default();

    out.lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            Some(Commit {
                short: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                when: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

fn parse_numstat(output: &str) -> std::collections::HashMap<String, (u32, u32)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let added = parts.next()?;
            let removed = parts.next()?;
            let path = parts.next()?;
            Some((
                path.to_string(),
                (
                    added.parse().unwrap_or(0),
                    removed.parse().unwrap_or(0),
                ),
            ))
        })
        .collect()
}

fn capture(header: &str, key: &str) -> u32 {
    header
        .split_once(key)
        .and_then(|(_, rest)| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .unwrap_or(0)
}
