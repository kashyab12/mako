//! Mako — a native desktop for the Pi coding agent.
//!
//! The agent runs in its own process (`pi --mode rpc`) and this binary is only
//! the interface. Nothing here links against Pi; the protocol is JSONL over
//! stdio and is documented for exactly this use.

mod composer;
mod effort;
mod git;
mod inspector;
mod model_picker;
mod rpc;
mod session;
mod sessions;
mod theme;
mod ui;

use composer::{Composer, Submit};
use effort::{EffortPicker, SelectEffort};
use inspector::Inspector;
use model_picker::{ModelPicker, SelectModel};
use sessions::{relative, SessionEntry, SessionIndex};
use gpui::prelude::*;
use gpui::{
    actions, div, px, App, Application, Bounds, Context, Entity, FocusHandle, Focusable,
    MouseButton,
    KeyBinding, ScrollHandle, SharedString, Window, WindowBackgroundAppearance, WindowBounds,
    WindowOptions,
};
use gpui_component::scroll::Scrollbar;
use gpui_component::text::TextView;
use gpui_component::Root;
use rpc::{Incoming, PiRpc};
use session::{Exchange, SessionState, ToolCall};
use std::time::Duration;
use theme::{space, text, Theme};
use ui::{clip, eyebrow, fin, format_cost, format_tokens, lit_top, panel, workspace_name};

actions!(desk, [Send, Stop, CycleThinking, ToggleRail, ToggleInspector]);

/// How close to the end still counts as "following the stream".
const NEAR_BOTTOM: f32 = 96.0;

struct Desk {
    theme: Theme,
    state: SessionState,
    rpc: Option<PiRpc>,
    composer: Entity<Composer>,
    model_picker: Entity<ModelPicker>,
    effort_picker: Entity<EffortPicker>,
    inspector: Entity<Inspector>,
    rail_open: bool,
    inspector_open: bool,
    sessions: Vec<SessionEntry>,
    index: SessionIndex,
    git: git::GitStatus,
    focus: FocusHandle,
    /// Owns the transcript's scroll offset across renders.
    scroll: ScrollHandle,
    /// True while the reader is at the bottom, so the stream may follow.
    pinned: bool,
}

impl Desk {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut state = SessionState::default();
        let cwd = std::env::current_dir().unwrap_or_default();

        let rpc = match PiRpc::spawn(&cwd.to_string_lossy()) {
            Ok(mut client) => {
                // Ask for everything the first paint needs; the replies arrive
                // on the same channel as events and are folded in below.
                let _ = client.get_state();
                let _ = client.get_messages();
                let _ = client.available_models();
                state.connected = true;
                state.cwd = cwd.to_string_lossy().to_string();
                Some(client)
            }
            Err(error) => {
                state.fault = Some(error.to_string());
                None
            }
        };

        // The agent is on a channel, not a future: poll it on a cadence rather
        // than blocking the frame. 30ms is under the threshold where a token
        // landing looks late, and costs nothing when the queue is empty. The
        // view is only notified when something actually changed, so a quiet
        // session paints zero frames.
        cx.spawn(async move |this, cx| loop {
            cx.background_executor()
                .timer(Duration::from_millis(30))
                .await;
            let alive = this.update(cx, |desk: &mut Desk, cx| {
                let mut dirty = false;
                let mut records = Vec::new();
                if let Some(rpc) = desk.rpc.as_ref() {
                    while let Ok(record) = rpc.incoming.try_recv() {
                        records.push(record);
                    }
                }
                for record in records {
                    match record {
                        Incoming::Event(event) => dirty |= desk.state.apply(&event),
                        Incoming::Response(response) => {
                            let Some(data) = response.data.as_ref() else {
                                continue;
                            };
                            match response.command.as_deref() {
                                Some("get_state") => desk.state.apply_state(data),
                                Some("get_messages") => desk.state.apply_messages(data),
                                Some("get_available_models") => desk.state.apply_models(data),
                                Some("get_session_stats") => desk.state.apply_stats(data),
                                _ => {}
                            }
                            dirty = true;
                        }
                    }
                }
                if dirty {
                    let models = desk.state.models.clone();
                    let current = desk.state.model.clone();
                    desk.model_picker.update(cx, |picker, cx| {
                        picker.set_models(models, cx);
                        picker.set_current(current, cx);
                    });
                    let levels = desk.state.thinking_levels.clone();
                    let thinking = desk.state.thinking.clone();
                    desk.effort_picker.update(cx, |picker, cx| {
                        picker.set(levels, thinking, cx);
                    });
                    if !desk.state.streaming {
                        // Only once the agent has stopped: git status is three
                        // subprocesses, and running them per token would spend
                        // more time in `fork` than in rendering.
                        let cwd = desk.state.cwd.clone();
                        desk.refresh_inspector(&cwd, cx);
                    }
                    desk.follow_stream();
                    cx.notify();
                }
            });
            if alive.is_err() {
                break;
            }
        })
        .detach();

        let composer = cx.new(|cx| Composer::new(window, cx));
        cx.subscribe(&composer, |desk, _composer, event: &Submit, cx| {
            desk.dispatch_prompt(event.0.clone(), cx);
        })
        .detach();

        let theme = Theme::dark();
        let model_picker = cx.new(|cx| ModelPicker::new(theme.clone(), window, cx));
        cx.subscribe(&model_picker, |desk, _picker, event: &SelectModel, cx| {
            if let Some(rpc) = desk.rpc.as_mut() {
                let _ = rpc.set_model(&event.provider, &event.id);
                // Ask for the settled state rather than assuming the switch
                // took: the host clamps the thinking level to what the new
                // model supports, and that has to come back from Pi.
                let _ = rpc.get_state();
            }
            cx.notify();
        })
        .detach();

        let effort_picker = cx.new(|_| EffortPicker::new(theme.clone()));
        cx.subscribe(&effort_picker, |desk, _picker, event: &SelectEffort, cx| {
            if let Some(rpc) = desk.rpc.as_mut() {
                let _ = rpc.set_thinking_level(&event.0);
            }
            desk.state.thinking = event.0.clone();
            cx.notify();
        })
        .detach();

        let inspector = cx.new(|cx| Inspector::new(theme.clone(), window, cx));

        let mut index = SessionIndex::default();
        let cwd_string = cwd.to_string_lossy().to_string();
        let sessions = index.scan(None);
        let git_status = git::status(&cwd_string);

        Self {
            theme,
            state,
            rpc,
            composer,
            model_picker,
            effort_picker,
            inspector,
            rail_open: true,
            inspector_open: true,
            sessions,
            index,
            git: git_status,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            pinned: true,
        }
    }

    /// Follow the stream only while the reader is already at the bottom. The
    /// moment they scroll up to read something, the view stops moving under
    /// them — the same rule the web build follows.
    fn follow_stream(&mut self) {
        if self.pinned {
            self.scroll.scroll_to_bottom();
        }
    }

    /// Send a prompt and record it optimistically, so the question appears the
    /// instant it is asked rather than when the agent gets round to echoing it.
    fn dispatch_prompt(&mut self, text: String, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.prompt(&text);
        }
        self.state.push_prompt(text);
        self.pinned = true;
        self.follow_stream();
        cx.notify();
    }

    fn send(&mut self, _: &Send, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.submit(window, cx));
    }

    fn stop(&mut self, _: &Stop, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.abort();
        }
        cx.notify();
    }

    fn cycle_thinking(&mut self, _: &CycleThinking, _window: &mut Window, cx: &mut Context<Self>) {
        let levels = &self.state.thinking_levels;
        if levels.is_empty() {
            return;
        }
        let at = levels.iter().position(|l| *l == self.state.thinking);
        let next = levels[(at.map_or(0, |i| i + 1)) % levels.len()].clone();
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.set_thinking_level(&next);
        }
        self.state.thinking = next;
        cx.notify();
    }

    fn toggle_rail(&mut self, _: &ToggleRail, _window: &mut Window, cx: &mut Context<Self>) {
        self.rail_open = !self.rail_open;
        cx.notify();
    }

    fn toggle_inspector(
        &mut self,
        _: &ToggleInspector,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.inspector_open = !self.inspector_open;
        cx.notify();
    }

    /// Hand the inspector the settled session numbers and let it re-read git.
    fn refresh_inspector(&mut self, cwd: &str, cx: &mut Context<Self>) {
        let model_name = self.state.model.name.clone();
        let provider = self.state.model.provider.clone();
        let thinking = self.state.thinking.clone();
        let context_window = self.state.model.context_window;
        let tokens = self.state.tokens;
        let cost = self.state.cost;
        let cwd = cwd.to_string();

        self.inspector.update(cx, |inspector, cx| {
            inspector.model_name = model_name;
            inspector.provider = provider;
            inspector.thinking = thinking;
            inspector.context_window = context_window;
            inspector.tokens = tokens;
            inspector.cost = cost;
            inspector.refresh(&cwd, cx);
        });
    }

}

impl Focusable for Desk {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Desk {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();

        div()
            .key_context("Desk")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::stop))
            .on_action(cx.listener(Self::cycle_thinking))
            .on_action(cx.listener(Self::toggle_rail))
            .on_action(cx.listener(Self::toggle_inspector))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .text_size(text::UI)
            .child(self.title_bar(&theme))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .when(self.rail_open, |row| row.child(self.rail(&theme, cx)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(self.transcript(&theme, window, cx))
                            .child(self.composer(&theme, cx)),
                    )
                    .when(self.inspector_open, |row| {
                        row.child(
                            panel(&theme)
                                .w(space::INSPECTOR_WIDTH)
                                .flex_none()
                                .border_l_1()
                                .border_color(theme.hairline)
                                .child(self.inspector.clone()),
                        )
                    }),
            )
            .child(self.status_bar(&theme))
    }
}

impl Desk {
    fn title_bar(&self, theme: &Theme) -> impl IntoElement {
        let title = if self.state.session_name.is_empty() {
            workspace_name(&self.state.cwd)
        } else {
            self.state.session_name.clone()
        };

        div()
            .flex()
            .flex_col()
            .flex_none()
            .child(
                div()
                    .h(space::TITLEBAR)
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme.surface)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.0))
                            .child(fin(theme, px(13.0)))
                            .when(self.state.streaming, |row| {
                                row.child(
                                    div()
                                        .size(px(5.0))
                                        .rounded_full()
                                        .bg(theme.foreground.opacity(0.7)),
                                )
                            })
                            .child(
                                div()
                                    .text_size(text::UI)
                                    .text_color(theme.foreground)
                                    .child(SharedString::from(title)),
                            ),
                    ),
            )
            .child(div().h(px(1.0)).bg(theme.hairline))
    }

    fn rail(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.state.session_file.clone();

        panel(theme)
            .w(space::RAIL_WIDTH)
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.hairline)
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(36.0))
                    .px(px(10.0))
                    .child(
                        div()
                            .text_size(text::UI)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(SharedString::from(workspace_name(&self.state.cwd))),
                    ),
            )
            .child(div().h(px(1.0)).bg(theme.hairline))
            .child(
                div()
                    .id("session-rail")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(6.0))
                    .children(self.sessions.iter().take(200).enumerate().map(
                        |(index, entry)| {
                            let selected = active
                                .as_deref()
                                .is_some_and(|path| path == entry.path.to_string_lossy());
                            let path = entry.path.to_string_lossy().to_string();
                            let theme = theme.clone();

                            div()
                                .id(("session", index))
                                .flex()
                                .flex_col()
                                .gap(px(1.0))
                                .rounded(space::RADIUS)
                                .px(px(7.0))
                                .py(px(5.0))
                                .when(selected, |row| row.bg(theme.selected()))
                                .hover(|style| style.bg(theme.hover()))
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(move |desk, _event, _window, cx| {
                                        desk.open_session(&path, cx);
                                    }),
                                )
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .text_size(text::UI)
                                                .text_color(theme.foreground)
                                                .child(SharedString::from(clip(
                                                    entry.title(),
                                                    30,
                                                ))),
                                        )
                                        .child(
                                            div()
                                                .text_size(text::MICRO)
                                                .text_color(theme.faint)
                                                .child(SharedString::from(relative(
                                                    entry.modified,
                                                ))),
                                        ),
                                )
                                .child(
                                    div()
                                        .text_size(text::MICRO)
                                        .text_color(theme.faint)
                                        .child(SharedString::from(format!(
                                            "{} messages",
                                            entry.messages
                                        ))),
                                )
                        },
                    )),
            )
    }

    /// Switch the agent to another session and reload the transcript.
    fn open_session(&mut self, path: &str, cx: &mut Context<Self>) {
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.switch_session(path);
            // The switch replaces the whole conversation, so ask for it rather
            // than trying to patch what is on screen.
            let _ = rpc.get_state();
            let _ = rpc.get_messages();
        }
        self.state.exchanges.clear();
        self.pinned = true;
        cx.notify();
    }

    fn transcript(
        &self,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(26.0))
            .w_full()
            .max_w(space::COLUMN)
            .px(px(24.0))
            .py(px(22.0));

        if self.state.exchanges.is_empty() {
            column = column.child(self.empty_state(theme));
        }

        for (index, exchange) in self.state.exchanges.iter().enumerate() {
            column = column.child(self.exchange(theme, exchange, index, window, cx));
        }

        if let Some(fault) = &self.state.fault {
            column = column.child(
                div()
                    .rounded(space::RADIUS)
                    .bg(theme.removed.opacity(0.10))
                    .px(px(12.0))
                    .py(px(9.0))
                    .text_size(text::META)
                    .text_color(theme.removed)
                    .child(SharedString::from(fault.clone())),
            );
        }

        div()
            .relative()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .id("transcript")
                    .track_scroll(&self.scroll)
                    .size_full()
                    .overflow_y_scroll()
                    .on_scroll_wheel(cx.listener(|desk, _event, _window, _cx| {
                        // Re-derive the pin from the offset rather than from
                        // the wheel's direction: a fling that lands back at the
                        // bottom should resume following. GPUI's scroll offset
                        // runs negative as content moves up, so "at the bottom"
                        // is the offset having reached its maximum extent.
                        let offset = desk.scroll.offset().y;
                        let max = desk.scroll.max_offset().height;
                        desk.pinned = (offset.abs() - max.abs()).abs() < px(NEAR_BOTTOM);
                    }))
                    .child(div().flex().justify_center().child(column)),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom_0()
                    .w(px(10.0))
                    .child(Scrollbar::vertical(&self.scroll)),
            )
    }

    fn empty_state(&self, theme: &Theme) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .text_size(text::BODY)
                    .text_color(theme.foreground)
                    .child("Start a turn"),
            )
            .child(
                div()
                    .text_size(text::META)
                    .text_color(theme.faint)
                    .child(SharedString::from(self.state.cwd.clone())),
            )
    }

    fn exchange(
        &self,
        theme: &Theme,
        exchange: &Exchange,
        id: usize,
        window: &mut Window,
        cx: &mut App,
    ) -> impl IntoElement {
        let mut block = div().flex().flex_col().gap(px(12.0));

        if !exchange.prompt.is_empty() {
            // The prompt gets its own surface, so whose words these are is
            // never in question.
            block = block.child(
                div()
                    .rounded(space::RADIUS_XL)
                    .bg(theme.raised)
                    .border_1()
                    .border_color(theme.hairline)
                    .child(lit_top(theme))
                    .child(
                        div()
                            .px(px(14.0))
                            .py(px(10.0))
                            .text_size(text::BODY)
                            .child(SharedString::from(exchange.prompt.clone())),
                    ),
            );
        }

        let reply = &exchange.reply;

        if !reply.thinking.is_empty() {
            block = block.child(
                div()
                    .rounded(space::RADIUS)
                    .bg(theme.raised.opacity(0.5))
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(text::SMALL)
                    .text_color(theme.faint)
                    .child(SharedString::from(clip(&reply.thinking, 220))),
            );
        }

        for call in &reply.tools {
            block = block.child(self.tool_row(theme, call));
        }

        if !reply.text.is_empty() {
            // Real markdown: headings, lists, links, and fenced code with
            // syntax highlighting, rendered natively rather than as one blob.
            block = block.child(
                div().text_size(text::BODY).child(TextView::markdown(
                    ("reply", id),
                    reply.text.clone(),
                    window,
                    cx,
                )),
            );
        }

        if reply.streaming && reply.is_empty() {
            block = block.child(
                div()
                    .text_size(text::UI)
                    .text_color(theme.faint)
                    .child("Thinking…"),
            );
        }

        block
    }

    fn tool_row(&self, theme: &Theme, call: &ToolCall) -> impl IntoElement {
        let tint = if call.failed {
            theme.removed
        } else if call.done {
            theme.faint
        } else {
            theme.foreground.opacity(0.8)
        };

        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded(space::RADIUS)
            .border_1()
            .border_color(theme.hairline)
            .bg(theme.surface)
            .px(px(9.0))
            .py(px(5.0))
            .child(
                div()
                    .text_size(text::META)
                    .text_color(tint)
                    .child(SharedString::from(call.name.clone())),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_size(text::META)
                    .text_color(theme.faint)
                    .child(SharedString::from(clip(&call.summary, 72))),
            )
            .when(!call.done, |row| {
                row.child(
                    div()
                        .text_size(text::MICRO)
                        .text_color(theme.foreground.opacity(0.7))
                        .child("running"),
                )
            })
    }

    fn composer(&self, theme: &Theme, cx: &App) -> impl IntoElement {
        let ready = !self.composer.read(cx).is_empty(cx);

        div()
            .flex_none()
            .flex()
            .justify_center()
            .px(px(24.0))
            .pb(px(16.0))
            .child(
                div()
                    .w_full()
                    .max_w(space::COLUMN)
                    .rounded(space::RADIUS_XL)
                    .bg(theme.surface)
                    .border_1()
                    .border_color(theme.border)
                    .child(lit_top(theme))
                    .child(self.composer.clone())
                    .child(div().h(px(1.0)).bg(theme.hairline))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .px(px(10.0))
                            .py(px(7.0))
                            .child(self.model_picker.clone())
                            .child(self.effort_picker.clone())
                            .child(div().flex_1())
                            .child(
                                // The primary action, filled only when there is
                                // something to send.
                                div()
                                    .size(px(26.0))
                                    .rounded_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .bg(if ready {
                                        theme.accent
                                    } else {
                                        theme.foreground.opacity(0.10)
                                    })
                                    .text_size(text::UI)
                                    .text_color(if ready {
                                        theme.on_accent()
                                    } else {
                                        theme.faint
                                    })
                                    .child("↑"),
                            ),
                    ),
            )
    }

    fn status_bar(&self, theme: &Theme) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .flex_none()
            .child(div().h(px(1.0)).bg(theme.hairline))
            .child(
                div()
                    .h(space::STATUSBAR)
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .bg(theme.surface)
                    .px(px(10.0))
                    .text_size(text::SMALL)
                    .text_color(theme.faint)
                    .child(SharedString::from(workspace_name(&self.state.cwd)))
                    .child(div().flex_1())
                    .child(SharedString::from(format!(
                        "{} tokens",
                        format_tokens(self.state.tokens)
                    )))
                    .child(SharedString::from(format!(
                        "{} spent",
                        format_cost(self.state.cost)
                    ))),
            )
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        // Brings the component library's own key bindings, theme, and the
        // hosts that dialogs, popovers, and notifications render into.
        gpui_component::init(cx);
        theme::apply_to_components(&Theme::dark(), cx);

        cx.bind_keys([
            KeyBinding::new("cmd-escape", Stop, Some("Desk")),
            KeyBinding::new("cmd-.", CycleThinking, Some("Desk")),
            KeyBinding::new("cmd-b", ToggleRail, Some("Desk")),
            KeyBinding::new("cmd-i", ToggleInspector, Some("Desk")),
        ]);

        let bounds = Bounds::centered(None, gpui::size(px(1480.0), px(940.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // The native equivalent of the web build's depth layer: the system
            // blurs what is behind the window, and the panels above are
            // translucent fills over it.
            window_background: WindowBackgroundAppearance::Blurred,
            ..Default::default()
        };

        let window = cx
            .open_window(options, |window, cx| {
                let desk = cx.new(|cx| Desk::new(window, cx));
                // Focus the composer on open: the first thing anyone does here
                // is type.
                window.focus(&desk.read(cx).composer.focus_handle(cx));
                cx.new(|cx| Root::new(desk, window, cx))
            })
            .expect("could not open the window");

        window
            .update(cx, |_, window, _| window.set_window_title("Mako"))
            .ok();
    });
}
