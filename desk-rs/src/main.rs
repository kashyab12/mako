//! Mako — a native desktop for the Pi coding agent.
//!
//! The agent runs in its own process (`pi --mode rpc`) and this binary is only
//! the interface. Nothing here links against Pi; the protocol is JSONL over
//! stdio and is documented for exactly this use.

mod assets;
mod composer;
mod effort;
mod fuzzy;
mod git;
mod inspector;
mod model_picker;
mod palette;
mod prefs;
mod rail;
mod rpc;
mod session;
mod sessions;
mod theme;
mod ui;

use composer::{Abort, Composer, Submit};
use effort::{EffortPicker, SelectEffort};
use inspector::Inspector;
use palette::{Command, Entry, Palette, Run};
use rail::{Rail, RailEvent};
use model_picker::{ModelPicker, SelectModel};
use sessions::{relative, SessionEntry, SessionIndex};
use gpui::prelude::*;
use gpui::{
    actions, div, px, App, Application, Bounds, Context, Entity, FocusHandle, Focusable,
    MouseButton,
    KeyBinding, ScrollHandle, SharedString, Window, WindowBackgroundAppearance, WindowBounds,
    WindowOptions,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::clipboard::Clipboard;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::divider::Divider;
use gpui_component::spinner::Spinner;
use gpui_component::kbd::Kbd;
use gpui_component::resizable::{h_resizable, resizable_panel};
use gpui_component::scroll::Scrollbar;
use gpui_component::skeleton::Skeleton;
use gpui_component::text::{TextView, TextViewStyle};
use gpui_component::{Icon, IconName, Root, Sizable};
use rpc::{Incoming, PiRpc, Queue};
use session::{Exchange, SessionState, ToolCall};
use std::time::Duration;
use theme::{space, text, Theme};
use ui::{clip, fin, format_cost, format_tokens, lit_top, panel, workspace_name};

actions!(
    desk,
    [
        Send,
        Stop,
        CycleThinking,
        ToggleRail,
        ToggleInspector,
        OpenPalette,
        OpenSettings,
        QueueAfter,
        Dismiss,
        Up,
        Down
    ]
);

/// How close to the end still counts as "following the stream".
const NEAR_BOTTOM: f32 = 96.0;

/// A faint dot between status-bar fields — quieter than a pipe, and it does
/// not read as a border the way a rule would.
fn dot_separator(theme: &Theme) -> impl IntoElement {
    div()
        .size(px(2.0))
        .rounded_full()
        .bg(theme.faint.opacity(0.45))
}

/// How an assistant reply's markdown is rendered.
///
/// The library's defaults are tuned for a document, not a transcript: a full
/// rem between paragraphs and headings that step up hard from the body. In a
/// column of answers that reads as loose and shouty, so both are pulled in.
fn markdown_style(theme: &Theme) -> TextViewStyle {
    let mut code_block = gpui::StyleRefinement::default();
    code_block.background = Some(theme.raised.opacity(0.55).into());
    code_block.corner_radii.top_left = Some(space::RADIUS.into());
    code_block.corner_radii.top_right = Some(space::RADIUS.into());
    code_block.corner_radii.bottom_left = Some(space::RADIUS.into());
    code_block.corner_radii.bottom_right = Some(space::RADIUS.into());

    TextViewStyle::default()
        .paragraph_gap(gpui::rems(0.72))
        .code_block(code_block)
        // A heading inside a chat reply marks a section of one answer, not a
        // chapter. One step over the body is enough to see it; three is a
        // magazine.
        .heading_font_size(|level, base| match level {
            1 => base + px(4.0),
            2 => base + px(2.0),
            3 => base + px(1.0),
            _ => base,
        })
}

/// The glyph for a tool, by what the tool actually does.
///
/// Matched on substrings rather than exact names because Pi's tool set is not
/// fixed — an MCP server can add `github_search` tomorrow, and it should get
/// the search glyph without anyone editing this list.
fn tool_glyph(name: &str) -> IconName {
    let name = name.to_ascii_lowercase();
    if name.contains("bash") || name.contains("shell") || name.contains("terminal") {
        IconName::SquareTerminal
    } else if name.contains("write") || name.contains("edit") || name.contains("replace") {
        IconName::Replace
    } else if name.contains("read") || name.contains("file") || name.contains("notebook") {
        IconName::File
    } else if name.contains("glob") || name.contains("list") || name.contains("ls") {
        IconName::Folder
    } else if name.contains("grep") || name.contains("search") || name.contains("find") {
        IconName::Search
    } else if name.contains("fetch") || name.contains("web") || name.contains("url") {
        IconName::Globe
    } else if name.contains("task") || name.contains("agent") {
        IconName::Bot
    } else {
        IconName::Asterisk
    }
}

struct Desk {
    theme: Theme,
    state: SessionState,
    rpc: Option<PiRpc>,
    composer: Entity<Composer>,
    model_picker: Entity<ModelPicker>,
    effort_picker: Entity<EffortPicker>,
    inspector: Entity<Inspector>,
    palette: Entity<Palette>,
    rail: Entity<Rail>,
    rail_open: bool,
    inspector_open: bool,
    settings_open: bool,
    sessions: Vec<SessionEntry>,
    index: SessionIndex,
    focus: FocusHandle,
    /// Owns the transcript's scroll offset across renders.
    scroll: ScrollHandle,
    /// True while the reader is at the bottom, so the stream may follow.
    pinned: bool,
    /// Which tool calls have their output open, as (exchange, tool).
    ///
    /// Collapsed is the default because a transcript is read for the answer,
    /// and ten thousand lines of `grep` output between two paragraphs buries
    /// it. The row says what ran; opening it says what came back.
    opened_tools: std::collections::HashSet<(usize, usize)>,
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
                        // And re-read the session directory, so a session
                        // started in a terminal — or by this window — shows up
                        // in the rail without a restart. The index caches by
                        // mtime, so an unchanged file is a stat and nothing
                        // more.
                        desk.rescan_sessions(cx);
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

        let composer = cx.new(|cx| {
            Composer::new(
                theme.clone(),
                model_picker.clone(),
                effort_picker.clone(),
                window,
                cx,
            )
        });
        cx.subscribe(&composer, |desk, _composer, event: &Submit, cx| {
            desk.dispatch_prompt(event.text.clone(), event.queue, cx);
        })
        .detach();
        cx.subscribe(&composer, |desk, _composer, _: &Abort, cx| {
            if let Some(rpc) = desk.rpc.as_mut() {
                let _ = rpc.abort();
            }
            cx.notify();
        })
        .detach();

        let inspector = cx.new(|cx| Inspector::new(theme.clone(), window, cx));

        let palette = cx.new(|cx| Palette::new(theme.clone(), window, cx));
        cx.subscribe(&palette, |desk, _palette, event: &Run, cx| {
            desk.run_command(event.0.clone(), cx);
        })
        .detach();

        let rail = cx.new(|cx| Rail::new(theme.clone(), window, cx));
        cx.subscribe(&rail, |desk, _rail, event: &RailEvent, cx| match event {
            RailEvent::Open(path) => desk.open_session(&path.clone(), cx),
            RailEvent::NewSession => desk.run_command(Command::NewSession, cx),
            // Widening to every project means re-reading a different slice of
            // the store, which only the shell can do — it owns the index.
            RailEvent::ScopeChanged(_) => desk.rescan_sessions(cx),
            RailEvent::OpenWorkspace(path) => desk.open_workspace(&path.clone(), cx),
        })
        .detach();

        let mut index = SessionIndex::default();
        let cwd_string = cwd.to_string_lossy().to_string();
        let sessions = index.scan(Some(&cwd_string));
        rail.update(cx, |rail, cx| {
            rail.set_active(None, cwd_string.clone(), cx);
            rail.set_sessions(sessions.clone(), cx);
        });

        Self {
            theme,
            state,
            rpc,
            composer,
            model_picker,
            effort_picker,
            inspector,
            palette,
            rail,
            rail_open: true,
            inspector_open: true,
            settings_open: false,
            sessions,
            index,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            pinned: true,
            opened_tools: std::collections::HashSet::new(),
        }
    }

    /// Point the window at a different folder.
    ///
    /// The agent is a child process launched with a working directory, and Pi
    /// has no command to change it — so this genuinely restarts it. Dropping
    /// the old client is what kills the old one: `PiRpc` owns the child and
    /// reaps it on drop, which matters because it holds a model connection and
    /// would otherwise keep a request in flight against a folder nobody is
    /// looking at any more.
    fn open_workspace(&mut self, path: &str, cx: &mut Context<Self>) {
        if path == self.state.cwd {
            return;
        }

        // Ordered: kill first, then spawn. Two agents against two folders,
        // both writing to the same transcript view, is the one state this must
        // not pass through.
        self.rpc = None;

        self.state.exchanges.clear();
        self.state.session_file = None;
        self.state.session_name.clear();
        self.state.cost = 0.0;
        self.state.tokens = 0;
        self.state.cwd = path.to_string();
        self.opened_tools.clear();
        self.pinned = true;

        match PiRpc::spawn(path) {
            Ok(mut client) => {
                let _ = client.get_state();
                let _ = client.get_messages();
                let _ = client.available_models();
                self.rpc = Some(client);
                self.state.connected = true;
                self.state.fault = None;
            }
            Err(error) => {
                self.state.connected = false;
                self.state.fault = Some(error.to_string());
            }
        }

        // Both of these read `state.cwd`, so they have to run after it moves.
        self.rescan_sessions(cx);
        self.refresh_inspector(path, cx);
        cx.notify();
    }

    /// Re-read the session store and hand the result to the rail.
    ///
    /// The scope lives on the rail because that is where it is set, but the
    /// index lives here because it is a cache with a lifetime longer than any
    /// one view. Rescanning an unchanged store is a `stat` per file.
    fn rescan_sessions(&mut self, cx: &mut Context<Self>) {
        let scope = self.rail.read(cx).scope;
        let cwd = self.state.cwd.clone();
        let sessions = match scope {
            rail::Scope::Workspace => self.index.scan(Some(&cwd)),
            rail::Scope::All => self.index.scan(None),
        };
        let unchanged = sessions == self.sessions;
        self.sessions = sessions.clone();
        let active = self.state.session_file.clone();
        self.rail.update(cx, |rail, cx| {
            // Always: switching folders can land on a list that happens to be
            // identical — two empty ones, most obviously — and the header would
            // otherwise keep naming the folder we just left.
            rail.set_active(active, cwd, cx);
            // Only when it moved: rebuilding rows re-runs grouping and ranking
            // over every session, and this is called whenever the agent settles.
            if !unchanged {
                rail.set_sessions(sessions, cx);
            }
        });
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
    fn dispatch_prompt(&mut self, text: String, queue: Option<Queue>, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if let Some(rpc) = self.rpc.as_mut() {
            let _ = rpc.prompt(&text, queue);
        }
        // A queued message is not this turn's question — showing it above the
        // reply still being written would put it in the wrong place in the
        // conversation. Pi echoes it back when it actually lands.
        if queue.is_some() {
            cx.notify();
            return;
        }
        self.state.push_prompt(text);
        self.pinned = true;
        self.follow_stream();
        cx.notify();
    }

    fn send(&mut self, _: &Send, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.submit(None, window, cx));
    }

    /// Hold this one until the agent has stopped entirely.
    fn queue_after(&mut self, _: &QueueAfter, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| {
            composer.submit(Some(Queue::FollowUp), window, cx)
        });
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

    fn open_palette(&mut self, _: &OpenPalette, window: &mut Window, cx: &mut Context<Self>) {
        let entries = self.palette_entries();
        self.palette.update(cx, |palette, cx| {
            palette.set_entries(entries);
            palette.show(window, cx);
        });
    }

    fn open_settings(&mut self, _: &OpenSettings, _window: &mut Window, cx: &mut Context<Self>) {
        self.settings_open = true;
        cx.notify();
    }

    fn dismiss(&mut self, _: &Dismiss, _window: &mut Window, cx: &mut Context<Self>) {
        self.palette.update(cx, |palette, cx| palette.hide(cx));
        self.settings_open = false;
        cx.notify();
    }

    fn cursor_up(&mut self, _: &Up, _window: &mut Window, cx: &mut Context<Self>) {
        self.palette.update(cx, |palette, cx| palette.move_cursor(-1, cx));
    }

    fn cursor_down(&mut self, _: &Down, _window: &mut Window, cx: &mut Context<Self>) {
        self.palette.update(cx, |palette, cx| palette.move_cursor(1, cx));
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

    /// Everything the palette can reach, rebuilt when it opens so the model
    /// and session lists are never stale.
    fn palette_entries(&self) -> Vec<Entry> {
        let mut entries = vec![
            Entry {
                section: "Actions",
                title: "New session".into(),
                hint: "⌘N".into(),
                command: Command::NewSession,
            },
            Entry {
                section: "Actions",
                title: "Stop the current turn".into(),
                hint: "⌘⎋".into(),
                command: Command::Stop,
            },
            Entry {
                section: "Actions",
                title: "Toggle the session list".into(),
                hint: "⌘B".into(),
                command: Command::ToggleRail,
            },
            Entry {
                section: "Actions",
                title: "Toggle the inspector".into(),
                hint: "⌘I".into(),
                command: Command::ToggleInspector,
            },
            Entry {
                section: "Actions",
                title: "Settings".into(),
                hint: "⌘,".into(),
                command: Command::OpenSettings,
            },
        ];

        for model in &self.state.models {
            entries.push(Entry {
                section: "Switch model",
                title: model.name.clone(),
                hint: model.provider.clone(),
                command: Command::SelectModel {
                    provider: model.provider.clone(),
                    id: model.id.clone(),
                },
            });
        }

        for entry in self.sessions.iter().take(80) {
            entries.push(Entry {
                section: "Open session",
                title: entry.title().to_string(),
                hint: format!("{} messages", entry.messages),
                command: Command::OpenSession {
                    path: entry.path.to_string_lossy().to_string(),
                },
            });
        }

        entries
    }

    fn run_command(&mut self, command: Command, cx: &mut Context<Self>) {
        match command {
            Command::NewSession => {
                if let Some(rpc) = self.rpc.as_mut() {
                    let _ = rpc.new_session();
                    let _ = rpc.get_state();
                }
                self.state.exchanges.clear();
                self.pinned = true;
            }
            Command::Stop => {
                if let Some(rpc) = self.rpc.as_mut() {
                    let _ = rpc.abort();
                }
            }
            Command::ToggleRail => self.rail_open = !self.rail_open,
            Command::ToggleInspector => self.inspector_open = !self.inspector_open,
            Command::OpenSettings => self.settings_open = true,
            Command::SelectModel { provider, id } => {
                if let Some(rpc) = self.rpc.as_mut() {
                    let _ = rpc.set_model(&provider, &id);
                    let _ = rpc.get_state();
                }
            }
            Command::OpenSession { path } => self.open_session(&path, cx),
        }
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

        // Synced here rather than in the polling loop because both of these
        // touch the text field, and a field needs a `Window` to move its caret
        // — which a background task does not have. Both calls return early when
        // nothing moved, so this cannot drive a repaint loop.
        let streaming = self.state.streaming;
        let compacting = self.state.compacting;
        let retrying = self.state.retrying;
        let queued = self.state.queued_steering + self.state.queued_follow_up;
        let session = self.state.session_file.clone();
        self.composer.update(cx, |composer, cx| {
            composer.set_status(streaming, compacting, retrying, queued, window, cx);
            composer.set_session(session, window, cx);
        });

        div()
            .key_context("Desk")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::queue_after))
            .on_action(cx.listener(Self::stop))
            .on_action(cx.listener(Self::cycle_thinking))
            .on_action(cx.listener(Self::toggle_rail))
            .on_action(cx.listener(Self::toggle_inspector))
            .on_action(cx.listener(Self::open_palette))
            .on_action(cx.listener(Self::open_settings))
            .on_action(cx.listener(Self::dismiss))
            .on_action(cx.listener(Self::cursor_up))
            .on_action(cx.listener(Self::cursor_down))
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .text_size(text::UI)
            .child(self.title_bar(&theme, cx))
            .child(
                // The panel row has to be told it may not grow past the window.
                // Without `flex_1` + `min_h_0` it sizes to its tallest child —
                // a transcript is arbitrarily tall — so the composer slid off
                // the bottom edge and took the status bar with it. `min_h_0` is
                // the load-bearing half: flex items default to `min-height:
                // auto`, which refuses to shrink below content height no matter
                // what `flex_1` asks for.
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                // Real resizable panels. The dividers are draggable and the
                // widths persist across renders, which is the difference
                // between a layout and a mock-up.
                h_resizable("panels")
                    .when(self.rail_open, |group| {
                        group.child(
                            resizable_panel()
                                .size(space::RAIL_WIDTH)
                                .size_range(px(200.0)..px(420.0))
                                .child(self.rail.clone()),
                        )
                    })
                    .child(
                        resizable_panel().child(if self.settings_open {
                            self.settings(&theme, window, cx).into_any_element()
                        } else {
                            div()
                                .flex()
                                .flex_col()
                                .size_full()
                                // Same rule one level down: the transcript is
                                // the only part that may scroll, so it is the
                                // only part allowed to shrink.
                                .min_h_0()
                                .child(self.transcript(&theme, window, cx))
                                .child(self.composer.clone())
                                .into_any_element()
                        }),
                    )
                    .when(self.inspector_open, |group| {
                        group.child(
                            resizable_panel()
                                .size(space::INSPECTOR_WIDTH)
                                .size_range(px(300.0)..px(720.0))
                                .child(panel(&theme).size_full().child(self.inspector.clone())),
                        )
                    }),
                    ),
            )
            .child(self.status_bar(&theme))
            .child(self.palette.clone())
    }
}

impl Desk {
    fn title_bar(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let title = if self.state.session_name.is_empty() {
            workspace_name(&self.state.cwd)
        } else {
            self.state.session_name.clone()
        };

        // `title_bar` is private in the component crate, so this is built by
        // hand — but the part that actually matters is the traffic-light
        // inset, which the window sets below. Without it the controls overlap
        // whatever the app draws in the top-left.
        //
        // Every action here also has a chord, and the tooltips say so. Chords
        // are how this app is actually driven; the buttons exist so that the
        // chords are *discoverable*, not as the primary path.
        div()
            .h(space::TITLEBAR)
            .flex()
            .items_center()
            .gap(px(2.0))
            .bg(theme.surface)
            .border_b_1()
            .border_color(theme.hairline)
            .pr(px(8.0))
            // Clears the traffic lights, which the window insets at x=14.
            .child(div().w(px(78.0)).flex_none())
            .child(
                Button::new("toggle-rail")
                    .ghost()
                    .xsmall()
                    .icon(if self.rail_open {
                        IconName::PanelLeftClose
                    } else {
                        IconName::PanelLeftOpen
                    })
                    .tooltip("Sessions  ⌘B")
                    .on_click(cx.listener(|desk, _event, _window, cx| {
                        desk.rail_open = !desk.rail_open;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("new-session")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Plus)
                    .tooltip("New session  ⌘N")
                    .on_click(cx.listener(|desk, _event, _window, cx| {
                        desk.run_command(Command::NewSession, cx);
                    })),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .justify_center()
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
                            .child(SharedString::from(clip(&title, 64))),
                    ),
            )
            .child(
                Button::new("open-palette")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Search)
                    .tooltip("Search everything  ⌘K")
                    .on_click(cx.listener(|desk, _event, window, cx| {
                        let entries = desk.palette_entries();
                        desk.palette.update(cx, |palette, cx| {
                            palette.set_entries(entries);
                            palette.show(window, cx);
                        });
                    })),
            )
            .child(
                Button::new("open-settings")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Settings)
                    .tooltip("Settings  ⌘,")
                    .on_click(cx.listener(|desk, _event, _window, cx| {
                        desk.settings_open = true;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("toggle-inspector")
                    .ghost()
                    .xsmall()
                    .icon(if self.inspector_open {
                        IconName::PanelRightClose
                    } else {
                        IconName::PanelRightOpen
                    })
                    .tooltip("Inspector  ⌘I")
                    .on_click(cx.listener(|desk, _event, _window, cx| {
                        desk.inspector_open = !desk.inspector_open;
                        cx.notify();
                    })),
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
            .gap(px(28.0))
            .w_full()
            .max_w(space::COLUMN)
            .px(px(28.0))
            .py(px(26.0));

        if self.state.exchanges.is_empty() {
            // Pushed down toward the composer rather than pinned to the top of
            // an otherwise empty panel: the thing being introduced is the field
            // you are about to type in, so the introduction should sit near it.
            column = column.child(div().h(px(140.0)).flex_none()).child(self.empty_state(theme));
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

    /// The resting state: what this is, where it is pointed, and what to do.
    ///
    /// A blank column is the most common screen in the app — it is what every
    /// new session opens to — so it is worth more than a heading. Naming the
    /// working directory matters most: the agent can edit files here, and the
    /// one thing worth being certain of before typing is *which* files.
    fn empty_state(&self, theme: &Theme) -> impl IntoElement {
        let model = if self.state.model.name.is_empty() {
            "no model selected yet".to_string()
        } else {
            self.state.model.name.clone()
        };

        div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .py(px(24.0))
            .child(fin(theme, px(26.0)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(5.0))
                    .child(
                        div()
                            .text_size(text::TITLE)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.foreground)
                            .child("Ask Pi something"),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_size(text::META)
                            .text_color(theme.faint)
                            .child(Icon::new(IconName::Folder).size(px(11.0)))
                            .child(SharedString::from(clip(&self.state.cwd, 72))),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .text_size(text::META)
                            .text_color(theme.faint)
                            .child(Icon::new(IconName::Bot).size(px(11.0)))
                            .child(SharedString::from(model)),
                    ),
            )
    }

    fn exchange(
        &self,
        theme: &Theme,
        exchange: &Exchange,
        id: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut block = div().flex().flex_col().gap(px(11.0));

        if !exchange.prompt.is_empty() {
            // The prompt gets its own lit surface, so whose words these are is
            // never in question.
            block = block.child(
                div()
                    .rounded(space::RADIUS_XL)
                    .bg(theme.raised)
                    .border_1()
                    .border_color(theme.hairline)
                    .overflow_hidden()
                    .child(lit_top(theme))
                    .child(
                        div()
                            .px(px(15.0))
                            .py(px(11.0))
                            .text_size(text::BODY)
                            .line_height(px(21.0))
                            .child(SharedString::from(exchange.prompt.clone())),
                    ),
            );
        }

        let reply = &exchange.reply;

        if !reply.thinking.is_empty() {
            // Reasoning is an aside, not a message. It reads as one via a rule
            // down its left edge and no fill at all — the previous filled bar
            // had the same visual weight as the answer, so a transcript
            // alternated between two grey slabs with no hierarchy between them.
            block = block.child(
                div()
                    .flex()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex_none()
                            .w(px(2.0))
                            .rounded_full()
                            .bg(theme.foreground.opacity(0.13)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .py(px(1.0))
                            .text_size(text::SMALL)
                            .line_height(px(18.0))
                            .text_color(theme.faint)
                            .child(SharedString::from(clip(&reply.thinking, 320))),
                    ),
            );
        }

        if !reply.tools.is_empty() {
            block = block.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .children(
                        reply
                            .tools
                            .iter()
                            .enumerate()
                            .map(|(slot, call)| self.tool_row(theme, call, id, slot, cx))
                            .collect::<Vec<_>>(),
                    ),
            );
        }

        if !reply.text.is_empty() {
            // Real markdown: headings, lists, links, and fenced code with
            // syntax highlighting, rendered natively rather than as one blob.
            block = block.child(
                div().text_size(text::BODY).child(
                    TextView::markdown(("reply", id), reply.text.clone(), window, cx)
                        .style(markdown_style(theme)),
                ),
            );
        }

        if reply.streaming && reply.is_empty() {
            // A moving indicator, not the word "Thinking". Between the prompt
            // landing and the first token there is nothing else on screen, and
            // static text there is indistinguishable from a hang.
            block = block.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.0))
                    .text_size(text::UI)
                    .text_color(theme.faint)
                    .child(Spinner::new().xsmall().color(theme.faint))
                    .child("Working"),
            );
        }

        // The unit anyone copies is the answer, so there is one control per
        // exchange rather than one per message part — copying "the second
        // paragraph but not the code block" is not a thing people want.
        if !reply.text.is_empty() && !reply.streaming {
            block = block.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .mt(px(-4.0))
                    .ml(px(-4.0))
                    .child(
                        Clipboard::new(("copy-reply", id))
                            .value(SharedString::from(reply.text.clone())),
                    ),
            );
        }

        block
    }

    fn tool_row(
        &self,
        theme: &Theme,
        call: &ToolCall,
        exchange: usize,
        slot: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let tint = if call.failed {
            theme.removed
        } else if call.done {
            theme.faint
        } else {
            theme.caution
        };

        // The glyph carries the outcome and the glyph *for the tool itself*
        // carries what kind of work it was, so a column of ten reads as a
        // shape rather than as ten lines of prose.
        let outcome = if call.failed {
            IconName::CircleX
        } else if call.done {
            IconName::Check
        } else {
            IconName::LoaderCircle
        };

        let key = (exchange, slot);
        let open = self.opened_tools.contains(&key);
        let has_output = !call.output.trim().is_empty();

        div()
            .flex()
            .flex_col()
            .rounded(space::RADIUS)
            .border_1()
            .border_color(if call.failed {
                theme.removed.opacity(0.35)
            } else {
                theme.hairline
            })
            .bg(theme.surface.opacity(0.6))
            .overflow_hidden()
            .child(
                div()
                    .id(("tool", exchange * 64 + slot))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(9.0))
                    .py(px(5.0))
                    .when(has_output, |row| {
                        row.cursor_pointer()
                            .hover(|style| style.bg(theme.hover()))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |desk, _event, _window, cx| {
                                    if !desk.opened_tools.remove(&key) {
                                        desk.opened_tools.insert(key);
                                    }
                                    cx.notify();
                                }),
                            )
                    })
                    .child(Icon::new(outcome).size(px(11.0)).text_color(tint))
                    .child(
                        Icon::new(tool_glyph(&call.name))
                            .size(px(11.0))
                            .text_color(theme.faint),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(text::META)
                            .text_color(theme.foreground.opacity(0.9))
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
                    // The chevron is the only thing that says a row can be
                    // opened, so it is absent when there is nothing behind it
                    // rather than present and inert.
                    .when(has_output, |row| {
                        row.child(
                            Icon::new(if open {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            })
                            .size(px(11.0))
                            .text_color(theme.faint),
                        )
                    }),
            )
            .when(open && has_output, |block| {
                block.child(Divider::horizontal()).child(
                    div()
                        .id(("tool-output", exchange * 64 + slot))
                        .max_h(px(320.0))
                        .overflow_y_scroll()
                        .px(px(11.0))
                        .py(px(8.0))
                        .font_family("ui-monospace")
                        .text_size(text::SMALL)
                        .line_height(px(17.0))
                        .text_color(theme.muted)
                        // Bounded before it reaches the element: a tool that
                        // returns a 40MB file should cost this frame nothing.
                        .child(SharedString::from(clip(&call.output, 12_000))),
                )
            })
    }

    /// Settings, as a full view rather than a modal.
    ///
    /// These are things you read and compare — a keyboard map most of all —
    /// and a dialog floating over a dimmed transcript is the wrong shape for
    /// that: cramped, hiding the thing being configured, and implying you are
    /// meant to leave quickly.
    fn settings(&self, theme: &Theme, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Each row asks the *window* what the binding actually is rather than
        // stating one. Hand-typed chords are a second source of truth that goes
        // stale the first time a binding moves; these cannot.
        let shortcuts: Vec<(Option<Kbd>, &str)> = vec![
            (
                Kbd::binding_for_action(&OpenPalette, Some("Desk"), window),
                "Search sessions, models, and commands",
            ),
            (
                Kbd::binding_for_action(&ToggleRail, Some("Desk"), window),
                "Show or hide the session list",
            ),
            (
                Kbd::binding_for_action(&ToggleInspector, Some("Desk"), window),
                "Show or hide the inspector",
            ),
            (
                Kbd::binding_for_action(&CycleThinking, Some("Desk"), window),
                "Cycle reasoning effort",
            ),
            (
                Kbd::binding_for_action(&Stop, Some("Desk"), window),
                "Stop the current turn",
            ),
            (
                Kbd::binding_for_action(&OpenSettings, Some("Desk"), window),
                "Open settings",
            ),
            (
                Kbd::binding_for_action(&Dismiss, Some("Desk"), window),
                "Close whatever is open",
            ),
        ];

        div()
            .flex()
            .flex_1()
            .min_h_0()
            .bg(theme.background)
            .child(
                div()
                    .w(px(190.0))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .border_r_1()
                    .border_color(theme.hairline)
                    .p(px(10.0))
                    .child(
                        Button::new("settings-back")
                            .ghost()
                            .small()
                            .icon(IconName::ArrowLeft)
                            .label("Back to the session")
                            .on_click(cx.listener(|desk, _event, _window, cx| {
                                desk.settings_open = false;
                                cx.notify();
                            })),
                    )
                    .child(div().h(px(6.0)))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.0))
                            .rounded(space::RADIUS)
                            .bg(theme.selected())
                            .px(px(8.0))
                            .py(px(5.0))
                            .text_size(text::UI)
                            .child(Icon::new(IconName::Settings2).size(px(12.0)))
                            .child("Keyboard"),
                    ),
            )
            .child(
                div()
                    .id("settings-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p(px(24.0))
                    .child(
                        div()
                            .text_size(text::TITLE)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.foreground)
                            .child("Keyboard"),
                    )
                    .child(
                        div()
                            .mt(px(2.0))
                            .text_size(text::META)
                            .text_color(theme.faint)
                            .child("Everything here is also reachable from the palette."),
                    )
                    .child(
                        div()
                            .mt(px(16.0))
                            .w_full()
                            .max_w(px(560.0))
                            .flex()
                            .flex_col()
                            .children(shortcuts.into_iter().enumerate().map(
                                |(index, (chord, what))| {
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(12.0))
                                        .py(px(9.0))
                                        .when(index > 0, |row| {
                                            row.border_t_1().border_color(theme.hairline)
                                        })
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .text_size(text::UI)
                                                .text_color(theme.foreground)
                                                .child(what),
                                        )
                                        .children(chord)
                                },
                            )),
                    ),
            )
    }

    fn status_bar(&self, theme: &Theme) -> impl IntoElement {
        // How full the context window is, which is the one number here that
        // changes what you *do* next — past roughly 80% the useful move is a
        // new session, not another prompt.
        let used = self.state.context_tokens.unwrap_or(self.state.tokens);
        let window_size = self.state.model.context_window;
        let fraction = if window_size > 0 {
            (used as f32 / window_size as f32).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let pressure = if fraction > 0.85 {
            theme.removed
        } else if fraction > 0.65 {
            theme.caution
        } else {
            theme.faint
        };

        let (dot, connection) = if self.state.fault.is_some() {
            (theme.removed, "agent unreachable")
        } else if self.state.streaming {
            (theme.added, "working")
        } else if self.state.connected {
            (theme.faint, "ready")
        } else {
            (theme.caution, "connecting")
        };

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
                    .gap(px(6.0))
                    .bg(theme.surface)
                    .px(px(10.0))
                    .text_size(text::SMALL)
                    .text_color(theme.faint)
                    .child(div().size(px(5.0)).rounded_full().bg(dot))
                    .child(connection)
                    .child(div().flex_1())
                    // A bar rather than a percentage: this is glanced at, not
                    // read, and a bar answers "how full" in one saccade.
                    .when(window_size > 0, |bar| {
                        bar.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .w(px(46.0))
                                        .h(px(3.0))
                                        .rounded_full()
                                        .bg(theme.foreground.opacity(0.12))
                                        .child(
                                            div()
                                                .h_full()
                                                .w(gpui::relative(fraction.max(0.02)))
                                                .rounded_full()
                                                .bg(pressure),
                                        ),
                                )
                                .child(
                                    div().text_color(pressure).child(SharedString::from(
                                        format!("{}% context", (fraction * 100.0).round() as u32),
                                    )),
                                ),
                        )
                        .child(dot_separator(theme))
                    })
                    .child(SharedString::from(format!(
                        "{} tokens",
                        format_tokens(self.state.tokens)
                    )))
                    .child(dot_separator(theme))
                    .child(SharedString::from(format_cost(self.state.cost))),
            )
    }
}

fn main() {
    Application::new()
        // Without this every icon resolves to nothing and the window
        // renders buttons with no glyphs in them.
        .with_assets(assets::Assets)
        .run(|cx: &mut App| {
        // Brings the component library's own key bindings, theme, and the
        // hosts that dialogs, popovers, and notifications render into.
        gpui_component::init(cx);
        theme::apply_to_components(&Theme::dark(), cx);

        cx.bind_keys([
            KeyBinding::new("cmd-escape", Stop, Some("Desk")),
            KeyBinding::new("cmd-enter", QueueAfter, Some("Desk")),
            KeyBinding::new("cmd-.", CycleThinking, Some("Desk")),
            KeyBinding::new("cmd-b", ToggleRail, Some("Desk")),
            KeyBinding::new("cmd-i", ToggleInspector, Some("Desk")),
            KeyBinding::new("cmd-k", OpenPalette, Some("Desk")),
            KeyBinding::new("cmd-,", OpenSettings, Some("Desk")),
            KeyBinding::new("escape", Dismiss, Some("Desk")),
            KeyBinding::new("up", Up, Some("Desk")),
            KeyBinding::new("down", Down, Some("Desk")),
        ]);

        let bounds = Bounds::centered(None, gpui::size(px(1480.0), px(940.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // Hidden chrome with the controls inset into our own title row,
            // the same arrangement the Electron build uses.
            titlebar: Some(gpui::TitlebarOptions {
                appears_transparent: true,
                traffic_light_position: Some(gpui::point(px(14.0), px(12.0))),
                title: Some("Mako".into()),
            }),
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
