//! Session state, shaped for rendering.
//!
//! The agent speaks in events; the view needs a settled picture. This module
//! is the fold between them, and it keeps the same shape the Electron desk
//! settled on — messages grouped into exchanges, because that is the unit
//! people think in and the unit "copy the answer" belongs to.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub name: String,
    /// The one argument worth putting on a collapsed row.
    pub summary: String,
    pub done: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Message {
    pub role_text: String,
    pub thinking: String,
    pub tools: Vec<ToolCall>,
}

#[derive(Debug, Clone, Default)]
pub struct Exchange {
    /// The user's question. Empty when the agent spoke unprompted.
    pub prompt: String,
    /// Everything the agent did to answer it.
    pub response: Vec<Message>,
}

#[derive(Debug, Default)]
pub struct SessionState {
    pub exchanges: Vec<Exchange>,
    pub streaming: bool,
    pub model: String,
    pub provider: String,
    pub thinking: String,
    pub cwd: String,
    /// Text of the in-flight assistant message, appended as tokens land.
    pub draft: String,
    pub connected: bool,
    pub fault: Option<String>,
}

impl SessionState {
    /// Fold one agent event into the picture.
    pub fn apply(&mut self, event: &Value) {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return;
        };

        match kind {
            "agent_start" => {
                self.streaming = true;
                self.draft.clear();
            }
            "agent_end" | "agent_settled" | "turn_end" => {
                self.streaming = false;
                if !self.draft.is_empty() {
                    // Take the draft before borrowing self again for the push.
                    let text = std::mem::take(&mut self.draft);
                    self.push_response(Message {
                        role_text: text,
                        ..Default::default()
                    });
                }
            }
            "message_update" | "message_end" => {
                if let Some(text) = assistant_text(event) {
                    self.draft = text;
                }
            }
            _ => {}
        }
    }

    pub fn push_prompt(&mut self, text: impl Into<String>) {
        self.exchanges.push(Exchange {
            prompt: text.into(),
            response: Vec::new(),
        });
    }

    fn push_response(&mut self, message: Message) {
        if let Some(last) = self.exchanges.last_mut() {
            last.response.push(message);
        } else {
            self.exchanges.push(Exchange {
                prompt: String::new(),
                response: vec![message],
            });
        }
    }

    /// Read the model and thinking level out of a `get_state` reply.
    pub fn apply_state(&mut self, data: &Value) {
        if let Some(model) = data.get("model") {
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                self.model = id.to_string();
            }
            if let Some(provider) = model.get("provider").and_then(Value::as_str) {
                self.provider = provider.to_string();
            }
        }
        if let Some(level) = data.get("thinkingLevel").and_then(Value::as_str) {
            self.thinking = level.to_string();
        }
        if let Some(cwd) = data.get("cwd").and_then(Value::as_str) {
            self.cwd = cwd.to_string();
        }
    }
}

/// Pull the plain text out of an assistant message event.
fn assistant_text(event: &Value) -> Option<String> {
    let content = event
        .get("message")
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let parts = content.as_array()?;
    let mut out = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                out.push_str(text);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}
