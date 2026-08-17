//! Pi Desk, native.
//!
//! The agent runs in its own process (`pi --mode rpc`) and this binary is only
//! the interface. Nothing here links against Pi; the protocol is JSONL over
//! stdio and is documented for exactly this use.

mod rpc;
mod session;
mod theme;

use gpui::prelude::*;
use gpui::{
    div, px, size, App, Application, Bounds, Context, FocusHandle, Focusable,
    KeyBinding, SharedString, Window, WindowBackgroundAppearance, WindowBounds, WindowOptions,
};
use rpc::{Incoming, PiRpc};
use session::SessionState;
use std::time::Duration;
use theme::Theme;

actions!(desk, [Send, Stop]);

use gpui::actions;

struct Desk {
    theme: Theme,
    state: SessionState,
    rpc: Option<PiRpc>,
    draft: String,
    focus: FocusHandle,
}

impl Desk {
    fn new(cx: &mut Context<Self>) -> Self {
        let mut state = SessionState::default();
        let rpc = match PiRpc::spawn(&std::env::current_dir().unwrap_or_default().to_string_lossy())
        {
            Ok(mut client) => {
                let _ = client.get_state();
                state.connected = true;
                Some(client)
            }
            Err(error) => {
                state.fault = Some(error.to_string());
                None
            }
        };

        // The agent is on a channel, not a future: poll it on a cadence rather
        // than blocking the frame. 30ms is under the threshold where a token
        // landing looks late, and costs nothing when the queue is empty.
        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(30))
                .await;
            let updated = this.update(cx, |desk: &mut Desk, cx| {
                let mut changed = false;
                if let Some(rpc) = desk.rpc.as_ref() {
                    while let Ok(record) = rpc.incoming.try_recv() {
                        match record {
                            Incoming::Event(event) => desk.state.apply(&event),
                            Incoming::Response(response) => {
                                if let Some(data) = response.data.as_ref() {
                                    desk.state.apply_state(data);
                                }
                            }
                        }
                        changed = true;
                    }
                }
                if changed {
                    cx.notify();
                }
                true
            });
            if updated.is_err() {
                break;
            }
        })
        .detach();

        Self {
            theme: Theme::dark(),
            state,
            rpc,
            draft: String::new(),
            focus: cx.focus_handle(),
        }
    }

    fn send(&mut self, _: &Send, _window: &mut Window, cx: &mut Context<Self>) {
        let text = self.draft.trim().to_string();
        if text.is_empty() {
            return;
        }
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.prompt(&text);
        }
        self.state.push_prompt(text);
        self.draft.clear();
        cx.notify();
    }

    fn stop(&mut self, _: &Stop, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.abort();
        }
        cx.notify();
    }
}

impl Focusable for Desk {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Desk {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = &self.theme;

        div()
            .key_context("Desk")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::stop))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.glass)
            .text_color(theme.foreground)
            .font_family("Geist")
            .text_size(px(13.0))
            .child(self.title_bar())
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.rail())
                    .child(self.transcript())
                    .child(self.composer_column()),
            )
    }
}

impl Desk {
    fn title_bar(&self) -> impl IntoElement {
        let theme = &self.theme;
        div()
            .h(px(38.0))
            .flex()
            .items_center()
            .px(px(14.0))
            // The specular top edge: GPUI has no per-element backdrop filter,
            // so the highlight that reads as glass is drawn, not filtered.
            .border_b_1()
            .border_color(theme.hairline)
            .child(
                div()
                    .pl(px(72.0))
                    .text_size(px(12.5))
                    .text_color(theme.muted)
                    .child(SharedString::from(if self.state.cwd.is_empty() {
                        "Pi Desk".to_string()
                    } else {
                        workspace_name(&self.state.cwd)
                    })),
            )
    }

    fn rail(&self) -> impl IntoElement {
        let theme = &self.theme;
        div()
            .w(px(264.0))
            .flex_none()
            .border_r_1()
            .border_color(theme.hairline)
            .bg(theme.surface)
            .child(
                div()
                    .p(px(10.0))
                    .text_size(px(11.0))
                    .text_color(theme.faint)
                    .child("Sessions"),
            )
    }

    fn transcript(&self) -> impl IntoElement {
        let theme = &self.theme;
        let mut column = div().flex().flex_col().gap(px(24.0)).p(px(24.0));

        for exchange in &self.state.exchanges {
            if !exchange.prompt.is_empty() {
                column = column.child(
                    div()
                        .rounded(px(12.0))
                        .bg(theme.raised)
                        .px(px(14.0))
                        .py(px(10.0))
                        .text_size(px(13.5))
                        .child(SharedString::from(exchange.prompt.clone())),
                );
            }
            for message in &exchange.response {
                column = column.child(
                    div()
                        .text_size(px(13.5))
                        .text_color(theme.foreground)
                        .child(SharedString::from(message.role_text.clone())),
                );
            }
        }

        if !self.state.draft.is_empty() {
            column = column.child(
                div()
                    .text_size(px(13.5))
                    .child(SharedString::from(self.state.draft.clone())),
            );
        }

        if let Some(fault) = &self.state.fault {
            column = column.child(
                div()
                    .text_color(theme.removed)
                    .text_size(px(12.5))
                    .child(SharedString::from(fault.clone())),
            );
        }

        div().flex_1().min_w_0().overflow_hidden().child(column)
    }

    fn composer_column(&self) -> impl IntoElement {
        let theme = &self.theme;
        div()
            .w(px(0.0))
            .flex_none()
            .child(div().bg(theme.background).w(px(0.0)))
    }
}

fn workspace_name(cwd: &str) -> String {
    cwd.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

fn main() {
    Application::new().run(|cx: &mut App| {
        cx.bind_keys([
            KeyBinding::new("enter", Send, Some("Desk")),
            KeyBinding::new("escape", Stop, Some("Desk")),
        ]);

        let bounds = Bounds::centered(None, size(px(1480.0), px(940.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // The native equivalent of the web build's depth layer: the system
            // blurs what is behind the window, and the panels above are
            // translucent fills over it.
            window_background: WindowBackgroundAppearance::Blurred,
            ..Default::default()
        };

        let window = cx
            .open_window(options, |_window, cx| cx.new(Desk::new))
            .expect("could not open the window");

        window
            .update(cx, |_, window, _| {
                window.set_window_title("Pi Desk");
            })
            .ok();

    });
}
