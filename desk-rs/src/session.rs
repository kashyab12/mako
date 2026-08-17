//! Session state, shaped for rendering.
//!
//! The agent speaks in events; the view needs a settled picture. This module is
//! the fold between them, and it keeps the shape the web build settled on —
//! messages grouped into exchanges, because that is the unit people think in
//! and the unit "copy the answer" belongs to.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Text,
    Thinking,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub name: String,
    /// The one argument worth putting on a collapsed row.
    pub summary: String,
    pub output: String,
    pub done: bool,
    pub failed: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Reply {
    pub text: String,
    pub thinking: String,
    pub tools: Vec<ToolCall>,
    pub streaming: bool,
}

impl Reply {
    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.thinking.is_empty() && self.tools.is_empty()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Exchange {
    /// The user's question. Empty when the agent spoke unprompted.
    pub prompt: String,
    /// Everything the agent did to answer it.
    pub reply: Reply,
}

#[derive(Debug, Clone, Default)]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub context_window: u64,
}

#[derive(Debug, Default)]
pub struct SessionState {
    pub exchanges: Vec<Exchange>,
    pub streaming: bool,
    pub model: ModelInfo,
    pub models: Vec<ModelInfo>,
    pub thinking: String,
    pub thinking_levels: Vec<String>,
    pub cwd: String,
    pub session_name: String,
    pub session_file: Option<String>,
    pub cost: f64,
    pub tokens: u64,
    pub context_tokens: Option<u64>,
    pub connected: bool,
    pub fault: Option<String>,
    /// The agent is rewriting its own history to fit the context window. It is
    /// not answering during this, which is why it gets a banner rather than
    /// being folded into `streaming`.
    pub compacting: bool,
    /// A transient provider failure is being retried, with the attempt number.
    pub retrying: Option<(u32, u32)>,
    /// Messages Pi is holding: interrupts first, then ones waiting for the end.
    pub queued_steering: usize,
    pub queued_follow_up: usize,
}

impl SessionState {
    /// Fold one agent event into the picture. Returns true when the view needs
    /// repainting — most events do not, and repainting on all of them would
    /// mean a frame per token of tool output.
    pub fn apply(&mut self, event: &Value) -> bool {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return false;
        };

        match kind {
            "agent_start" => {
                self.streaming = true;
                self.open_reply().streaming = true;
                true
            }
            "agent_end" | "agent_settled" | "turn_end" => {
                self.streaming = false;
                if let Some(last) = self.exchanges.last_mut() {
                    last.reply.streaming = false;
                }
                true
            }
            "message_update" | "message_end" => {
                let text = assistant_text(event);
                let thinking = assistant_thinking(event);
                let tools = assistant_tools(event);
                let reply = self.open_reply();
                if let Some(text) = text {
                    reply.text = text;
                }
                if let Some(thinking) = thinking {
                    reply.thinking = thinking;
                }
                if !tools.is_empty() {
                    reply.tools = tools;
                }
                true
            }
            "tool_execution_end" => {
                let name = event.get("toolName").and_then(Value::as_str).unwrap_or("");
                let reply = self.open_reply();
                if let Some(call) = reply.tools.iter_mut().rev().find(|c| c.name == name) {
                    call.done = true;
                }
                true
            }
            "queue_update" => {
                self.queued_steering = event
                    .get("steering")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                self.queued_follow_up = event
                    .get("followUp")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                true
            }
            "compaction_start" => {
                self.compacting = true;
                true
            }
            "compaction_end" => {
                self.compacting = false;
                true
            }
            "auto_retry_start" => {
                let attempt = event.get("attempt").and_then(Value::as_u64).unwrap_or(1) as u32;
                let max = event
                    .get("maxAttempts")
                    .and_then(Value::as_u64)
                    .unwrap_or(3) as u32;
                self.retrying = Some((attempt, max));
                true
            }
            "auto_retry_end" => {
                self.retrying = None;
                // A retry that ran out of attempts is the end of the turn, and
                // the reason it failed is the only thing worth surfacing.
                if event.get("success").and_then(Value::as_bool) == Some(false) {
                    if let Some(error) = event.get("finalError").and_then(Value::as_str) {
                        self.fault = Some(error.to_string());
                    }
                    self.streaming = false;
                }
                true
            }
            "thinking_level_changed" => {
                if let Some(level) = event.get("level").and_then(Value::as_str) {
                    self.thinking = level.to_string();
                }
                true
            }
            _ => false,
        }
    }

    /// The reply currently being written into, creating one if the agent spoke
    /// before any prompt (a resumed session).
    fn open_reply(&mut self) -> &mut Reply {
        if self.exchanges.is_empty() {
            self.exchanges.push(Exchange::default());
        }
        &mut self.exchanges.last_mut().expect("just ensured").reply
    }

    pub fn push_prompt(&mut self, text: impl Into<String>) {
        self.exchanges.push(Exchange {
            prompt: text.into(),
            reply: Reply {
                streaming: true,
                ..Default::default()
            },
        });
    }

    /// Read a `get_state` reply.
    pub fn apply_state(&mut self, data: &Value) {
        if let Some(model) = data.get("model") {
            self.model = model_info(model);
        }
        if let Some(level) = data.get("thinkingLevel").and_then(Value::as_str) {
            self.thinking = level.to_string();
        }
        // Trust the settled state over the event stream: a window that opens
        // onto a session already mid-turn never saw `agent_start`.
        if let Some(streaming) = data.get("isStreaming").and_then(Value::as_bool) {
            self.streaming = streaming;
        }
        if let Some(compacting) = data.get("isCompacting").and_then(Value::as_bool) {
            self.compacting = compacting;
        }
        if let Some(cwd) = data.get("cwd").and_then(Value::as_str) {
            self.cwd = cwd.to_string();
        }
        if let Some(name) = data.get("sessionName").and_then(Value::as_str) {
            self.session_name = name.to_string();
        }
        if let Some(file) = data.get("sessionFile").and_then(Value::as_str) {
            self.session_file = Some(file.to_string());
        }
        if let Some(levels) = data.get("thinkingLevels").and_then(Value::as_array) {
            self.thinking_levels = levels
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }

    /// Read a `get_available_models` reply.
    pub fn apply_models(&mut self, data: &Value) {
        let list = data
            .get("models")
            .and_then(Value::as_array)
            .or_else(|| data.as_array());
        let Some(list) = list else { return };
        self.models = list.iter().map(model_info).collect();
    }

    /// Read a `get_session_stats` reply.
    pub fn apply_stats(&mut self, data: &Value) {
        if let Some(cost) = data.get("cost").and_then(Value::as_f64) {
            self.cost = cost;
        }
        if let Some(total) = data
            .get("tokens")
            .and_then(|t| t.get("total"))
            .and_then(Value::as_u64)
        {
            self.tokens = total;
        }
    }

    /// Rebuild the whole transcript from a `get_messages` reply.
    pub fn apply_messages(&mut self, data: &Value) {
        let Some(list) = data
            .get("messages")
            .and_then(Value::as_array)
            .or_else(|| data.as_array())
        else {
            return;
        };

        self.exchanges.clear();
        for message in list {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            match role {
                "user" => {
                    let text = content_text(message.get("content"), Part::Text).unwrap_or_default();
                    self.exchanges.push(Exchange {
                        prompt: text,
                        reply: Reply::default(),
                    });
                }
                "assistant" => {
                    let text = content_text(message.get("content"), Part::Text);
                    let thinking = content_text(message.get("content"), Part::Thinking);
                    let tools = tool_calls(message.get("content"));
                    let reply = self.open_reply();
                    if let Some(text) = text {
                        if !reply.text.is_empty() {
                            reply.text.push_str("\n\n");
                        }
                        reply.text.push_str(&text);
                    }
                    if let Some(thinking) = thinking {
                        reply.thinking = thinking;
                    }
                    reply.tools.extend(tools);
                }
                "toolResult" | "tool" => {
                    let output = content_text(message.get("content"), Part::Text).unwrap_or_default();
                    let failed = message
                        .get("isError")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let reply = self.open_reply();
                    if let Some(call) = reply.tools.iter_mut().rev().find(|c| !c.done) {
                        call.output = output;
                        call.done = true;
                        call.failed = failed;
                    }
                }
                _ => {}
            }
        }
    }
}

fn model_info(value: &Value) -> ModelInfo {
    ModelInfo {
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| value.get("id").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        reasoning: value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        context_window: value
            .get("contextWindow")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn assistant_text(event: &Value) -> Option<String> {
    content_text(event.get("message").and_then(|m| m.get("content")), Part::Text)
}

fn assistant_thinking(event: &Value) -> Option<String> {
    content_text(
        event.get("message").and_then(|m| m.get("content")),
        Part::Thinking,
    )
}

fn assistant_tools(event: &Value) -> Vec<ToolCall> {
    tool_calls(event.get("message").and_then(|m| m.get("content")))
}

/// Pull one kind of part out of a message's content.
fn content_text(content: Option<&Value>, want: Part) -> Option<String> {
    let content = content?;

    if let Some(text) = content.as_str() {
        return (want == Part::Text).then(|| text.to_string());
    }

    let key = match want {
        Part::Text => "text",
        Part::Thinking => "thinking",
    };

    let mut out = String::new();
    for part in content.as_array()? {
        if part.get("type").and_then(Value::as_str) == Some(key) {
            if let Some(text) = part.get(key).and_then(Value::as_str) {
                out.push_str(text);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

fn tool_calls(content: Option<&Value>) -> Vec<ToolCall> {
    let Some(parts) = content.and_then(Value::as_array) else {
        return Vec::new();
    };

    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
        .map(|part| {
            let name = part
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            ToolCall {
                summary: primary_argument(part.get("arguments")),
                name,
                output: String::new(),
                done: false,
                failed: false,
            }
        })
        .collect()
}

/// The one argument worth putting on a collapsed row.
fn primary_argument(args: Option<&Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    for key in [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "directory",
    ] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            return value.replace('\n', " ");
        }
    }
    String::new()
}
