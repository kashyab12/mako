//! The Pi RPC client.
//!
//! Pi ships a headless mode that speaks JSONL over stdin and stdout, built for
//! exactly this: "embedding the agent in other applications, IDEs, or custom
//! UIs". That is what makes a native front end possible at all — the agent
//! itself stays in its own process, and this crate never links against it.
//!
//! Two rules from Pi's protocol documentation shape the reader below:
//!
//!   * Records are delimited by `\n` and nothing else. A generic line reader
//!     is *not* protocol-compliant, because several of them also split on
//!     U+2028 and U+2029, which are legal inside JSON strings and do occur in
//!     model output.
//!   * A trailing `\r` is tolerated but must be stripped.

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

/// One message from the agent: either a reply to a command or a live event.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Incoming {
    Response(Response),
    Event(Value),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Response {
    pub id: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThinkingLevel(pub String);

/// A running `pi --mode rpc` process.
pub struct PiRpc {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    /// Everything the agent emits, in order.
    pub incoming: Receiver<Incoming>,
}

impl PiRpc {
    /// Spawn the agent against a working directory.
    pub fn spawn(cwd: &str) -> Result<Self> {
        let mut child = Command::new("pi")
            .args(["--mode", "rpc"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Leaving stderr inherited keeps Pi's own diagnostics visible in
            // the terminal rather than silently swallowed.
            .stderr(Stdio::inherit())
            .spawn()
            .context("could not start `pi --mode rpc` — is pi on PATH?")?;

        let stdin = child.stdin.take().context("pi gave no stdin")?;
        let stdout = child.stdout.take().context("pi gave no stdout")?;
        let (tx, rx) = channel();

        thread::spawn(move || read_records(stdout, tx));

        Ok(Self {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            incoming: rx,
        })
    }

    /// Send a command. Returns the correlation id the reply will carry.
    pub fn send(&mut self, kind: &str, mut payload: Value) -> Result<String> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        if let Value::Object(map) = &mut payload {
            map.insert("id".into(), json!(id));
            map.insert("type".into(), json!(kind));
        }
        let mut line = serde_json::to_string(&payload)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;
        Ok(id)
    }

    pub fn prompt(&mut self, message: &str) -> Result<String> {
        self.send("prompt", json!({ "message": message }))
    }

    pub fn abort(&mut self) -> Result<String> {
        self.send("abort", json!({}))
    }

    pub fn get_state(&mut self) -> Result<String> {
        self.send("get_state", json!({}))
    }

    pub fn get_messages(&mut self) -> Result<String> {
        self.send("get_messages", json!({}))
    }

    pub fn available_models(&mut self) -> Result<String> {
        self.send("get_available_models", json!({}))
    }

    pub fn set_model(&mut self, provider: &str, model: &str) -> Result<String> {
        self.send("set_model", json!({ "provider": provider, "model": model }))
    }

    pub fn set_thinking_level(&mut self, level: &str) -> Result<String> {
        self.send("set_thinking_level", json!({ "level": level }))
    }
}

impl Drop for PiRpc {
    fn drop(&mut self) {
        // The agent owns a model connection; leaving it orphaned would keep a
        // request in flight after the window is gone.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Read strict JSONL: split on `\n` only, tolerate a trailing `\r`.
fn read_records(stdout: std::process::ChildStdout, tx: Sender<Incoming>) {
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();

    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }

        while matches!(buffer.last(), Some(b'\n') | Some(b'\r')) {
            buffer.pop();
        }
        if buffer.is_empty() {
            continue;
        }

        let Ok(text) = std::str::from_utf8(&buffer) else {
            continue;
        };
        // A record we cannot parse is skipped rather than fatal: the protocol
        // grows, and an unknown event should never take the window down.
        if let Ok(record) = serde_json::from_str::<Incoming>(text) {
            if tx.send(record).is_err() {
                break;
            }
        }
    }
}
