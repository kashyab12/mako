//! The inspector.
//!
//! Three lanes, each answering a different question:
//!
//!   Changes — what is different in the working tree, and commit it
//!   Context — what the agent is working with right now
//!   History — what has already landed
//!
//! The panels share one entity because they share one repository read: status
//! is polled once and all three read from it, rather than each shelling out to
//! git on its own schedule.

use gpui::prelude::*;
use gpui::{
    div, px, App, Context, Entity, EventEmitter, MouseButton, SharedString, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::input::{Input, InputState};
use gpui_component::Sizable;
use std::path::PathBuf;

use crate::git::{self, ChangedFile, GitStatus};
use crate::session::SessionState;
use crate::theme::{space, text, Theme};
use crate::ui::{clip, format_cost, format_tokens};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Changes,
    Context,
    History,
}

impl Lane {
    fn label(self) -> &'static str {
        match self {
            Lane::Changes => "Changes",
            Lane::Context => "Context",
            Lane::History => "History",
        }
    }
}

pub struct Inspector {
    theme: Theme,
    lane: Lane,
    status: GitStatus,
    commits: Vec<git::Commit>,
    /// The file whose patch is on screen, and the patch itself.
    open_file: Option<String>,
    patch: String,
    commit_message: Entity<InputState>,
    /// Mirrors the session's numbers for the Context lane.
    pub model_name: String,
    pub provider: String,
    pub thinking: String,
    pub context_window: u64,
    pub tokens: u64,
    pub cost: f64,
}

/// Raised when the repository changed underneath us and the shell should
/// refresh anything else that reads it.
pub struct RepoChanged;

impl EventEmitter<RepoChanged> for Inspector {}

impl Inspector {
    pub fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let commit_message = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(1, 6)
                .placeholder("Commit message")
        });

        Self {
            theme,
            lane: Lane::Changes,
            status: GitStatus::default(),
            commits: Vec::new(),
            open_file: None,
            patch: String::new(),
            commit_message,
            model_name: String::new(),
            provider: String::new(),
            thinking: String::new(),
            context_window: 0,
            tokens: 0,
            cost: 0.0,
        }
    }

    /// Re-read the repository. Cheap enough to call on every agent turn.
    pub fn refresh(&mut self, cwd: &str, cx: &mut Context<Self>) {
        self.status = git::status(cwd);
        if let Some(root) = self.status.root.clone() {
            self.commits = git::log(&root, 60);
            // Keep the open patch honest: the file may have changed under us.
            if let Some(path) = self.open_file.clone() {
                self.patch = git::diff(&root, &path);
            }
        }
        cx.notify();
    }

    pub fn absorb(&mut self, state: &SessionState) {
        self.model_name = state.model.name.clone();
        self.provider = state.model.provider.clone();
        self.thinking = state.thinking.clone();
        self.context_window = state.model.context_window;
        self.tokens = state.tokens;
        self.cost = state.cost;
    }

    fn root(&self) -> Option<PathBuf> {
        self.status.root.clone()
    }

    fn open(&mut self, path: String, cx: &mut Context<Self>) {
        if let Some(root) = self.root() {
            self.patch = git::diff(&root, &path);
        }
        self.open_file = Some(path);
        cx.notify();
    }

    fn toggle_stage(&mut self, file: &ChangedFile, cx: &mut Context<Self>) {
        let Some(root) = self.root() else { return };
        let paths = vec![file.path.clone()];
        if file.staged {
            git::unstage(&root, &paths);
        } else {
            git::stage(&root, &paths);
        }
        let cwd = root.to_string_lossy().to_string();
        self.refresh(&cwd, cx);
        cx.emit(RepoChanged);
    }

    fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else { return };
        let message = self.commit_message.read(cx).value().to_string();
        if message.trim().is_empty() {
            return;
        }
        // Nothing staged means "commit what I changed", matching the web build.
        if self.status.staged() == 0 {
            let all: Vec<String> = self.status.files.iter().map(|f| f.path.clone()).collect();
            git::stage(&root, &all);
        }
        if git::commit(&root, message.trim()).is_ok() {
            self.commit_message.update(cx, |state, cx| {
                state.set_value("", window, cx);
            });
            let cwd = root.to_string_lossy().to_string();
            self.refresh(&cwd, cx);
            cx.emit(RepoChanged);
        }
    }
}

impl Render for Inspector {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.tabs(&theme, cx))
            .child(div().h(px(1.0)).bg(theme.hairline))
            .child(match self.lane {
                Lane::Changes => self.changes(&theme, cx).into_any_element(),
                Lane::Context => self.context_lane(&theme).into_any_element(),
                Lane::History => self.history(&theme),
            })
    }
}

impl Inspector {
    fn tabs(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let active = self.lane;
        let changed = self.status.files.len();

        div()
            .flex()
            .items_center()
            .gap(px(2.0))
            .h(px(34.0))
            .px(px(6.0))
            .children(
                [Lane::Changes, Lane::Context, Lane::History]
                    .into_iter()
                    .enumerate()
                    .map(|(index, lane)| {
                        let theme = theme.clone();
                        div()
                            .id(("lane", index))
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .rounded(space::RADIUS)
                            .px(px(8.0))
                            .py(px(4.0))
                            .text_size(text::META)
                            .when(lane == active, |tab| {
                                tab.bg(theme.selected()).text_color(theme.foreground)
                            })
                            .when(lane != active, |tab| tab.text_color(theme.faint))
                            .hover(|style| style.bg(theme.hover()))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |inspector, _event, _window, cx| {
                                    inspector.lane = lane;
                                    cx.notify();
                                }),
                            )
                            .child(lane.label())
                            .when(lane == Lane::Changes && changed > 0, |tab| {
                                tab.child(
                                    div()
                                        .text_size(text::MICRO)
                                        .text_color(theme.caution)
                                        .child(SharedString::from(changed.to_string())),
                                )
                            })
                    }),
            )
    }

    fn changes(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        if self.status.root.is_none() {
            return blank(theme, "Not a git repository", "Run git init to track changes here.");
        }
        if self.status.files.is_empty() {
            return blank(
                theme,
                "Working tree is clean",
                "Edits appear here as Mako makes them.",
            );
        }

        let open = self.open_file.clone();

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .h(px(24.0))
                    .px(px(10.0))
                    .text_size(text::MICRO)
                    .text_color(theme.faint)
                    .child(SharedString::from(format!(
                        "{} changed",
                        self.status.files.len()
                    )))
                    .child(
                        div()
                            .text_color(theme.added)
                            .child(SharedString::from(format!("+{}", self.status.insertions()))),
                    )
                    .child(
                        div()
                            .text_color(theme.removed)
                            .child(SharedString::from(format!("−{}", self.status.deletions()))),
                    ),
            )
            .child(
                div()
                    .id("changed-files")
                    .max_h(px(220.0))
                    .overflow_y_scroll()
                    .px(px(4.0))
                    .children(self.status.files.iter().enumerate().map(|(index, file)| {
                        let selected = open.as_deref() == Some(file.path.as_str());
                        let theme = theme.clone();
                        let entry = file.clone();
                        let path = file.path.clone();
                        let tint = match file.status {
                            git::FileStatus::Added | git::FileStatus::Untracked => theme.added,
                            git::FileStatus::Deleted => theme.removed,
                            git::FileStatus::Renamed => theme.muted,
                            git::FileStatus::Modified => theme.caution,
                        };

                        div()
                            .id(("file", index))
                            .flex()
                            .items_center()
                            .gap(px(7.0))
                            .rounded(space::RADIUS_SM)
                            .px(px(6.0))
                            .py(px(3.0))
                            .when(selected, |row| row.bg(theme.selected()))
                            .hover(|style| style.bg(theme.hover()))
                            .child(
                                // Staging is its own target, so opening a file
                                // and staging it never get confused.
                                div()
                                    .id(("stage", index))
                                    .size(px(13.0))
                                    .rounded(px(3.0))
                                    .border_1()
                                    .border_color(if entry.staged {
                                        theme.foreground
                                    } else {
                                        theme.border
                                    })
                                    .when(entry.staged, |box_| box_.bg(theme.foreground))
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |inspector, _event, _window, cx| {
                                            inspector.toggle_stage(&entry, cx);
                                        }),
                                    ),
                            )
                            .child(
                                div()
                                    .w(px(10.0))
                                    .text_size(text::MICRO)
                                    .text_color(tint)
                                    .child(file.status.glyph()),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(text::META)
                                    .text_color(theme.foreground)
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(move |inspector, _event, _window, cx| {
                                            inspector.open(path.clone(), cx);
                                        }),
                                    )
                                    .child(SharedString::from(clip(&file.path, 36))),
                            )
                            .child(
                                div()
                                    .text_size(text::MICRO)
                                    .text_color(theme.added)
                                    .child(SharedString::from(format!("+{}", file.insertions))),
                            )
                            .child(
                                div()
                                    .text_size(text::MICRO)
                                    .text_color(theme.removed)
                                    .child(SharedString::from(format!("−{}", file.deletions))),
                            )
                    })),
            )
            .child(div().h(px(1.0)).bg(theme.hairline))
            .child(self.patch_view(theme))
            .child(self.commit_box(theme, cx))
    }

    /// The patch, coloured by line kind. Header lines are dimmed so the eye
    /// lands on the change rather than on the file bookkeeping.
    fn patch_view(&self, theme: &Theme) -> impl IntoElement {
        div()
            .id("patch")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(10.0))
            .py(px(6.0))
            .children(self.patch.lines().take(2_000).enumerate().map(|(index, line)| {
                let color = if line.starts_with("+++") || line.starts_with("---") {
                    theme.faint
                } else if line.starts_with('+') {
                    theme.added
                } else if line.starts_with('-') {
                    theme.removed
                } else if line.starts_with("@@") {
                    theme.muted
                } else {
                    theme.faint
                };
                div()
                    .id(("patch-line", index))
                    .text_size(text::MICRO)
                    .text_color(color)
                    .child(SharedString::from(line.to_string()))
            }))
    }

    fn commit_box(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let staged = self.status.staged();
        let total = self.status.files.len();

        div()
            .flex()
            .flex_col()
            .border_t_1()
            .border_color(theme.hairline)
            .p(px(6.0))
            .child(Input::new(&self.commit_message).appearance(false))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .pt(px(4.0))
                    .child(
                        div()
                            .flex_1()
                            .text_size(text::MICRO)
                            .text_color(theme.faint)
                            .child(SharedString::from(if staged > 0 {
                                format!("{staged} staged")
                            } else {
                                format!("{total} unstaged")
                            })),
                    )
                    .child(
                        Button::new("commit")
                            .primary()
                            .xsmall()
                            .label("Commit")
                            .on_click(cx.listener(|inspector, _event, window, cx| {
                                inspector.commit(window, cx);
                            })),
                    ),
            )
    }

    fn context_lane(&self, theme: &Theme) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .p(px(12.0))
            .child(fact(theme, "Model", &self.model_name))
            .child(fact(theme, "Provider", &self.provider))
            .child(fact(theme, "Reasoning", &self.thinking))
            .child(fact(
                theme,
                "Context window",
                &if self.context_window == 0 {
                    "—".to_string()
                } else {
                    format!("{} tokens", format_tokens(self.context_window))
                },
            ))
            .child(fact(theme, "Tokens billed", &format_tokens(self.tokens)))
            .child(fact(theme, "Spent", &format_cost(self.cost)))
    }

    fn history(&self, theme: &Theme) -> gpui::AnyElement {
        if self.commits.is_empty() {
            return blank(theme, "No commits yet", "The first commit shows up here.")
                .into_any_element();
        }

        div()
            .id("history")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p(px(8.0))
            .children(self.commits.iter().enumerate().map(|(index, commit)| {
                let theme = theme.clone();
                div()
                    .id(("commit", index))
                    .flex()
                    .flex_col()
                    .gap(px(1.0))
                    .rounded(space::RADIUS)
                    .px(px(6.0))
                    .py(px(5.0))
                    .hover(|style| style.bg(theme.hover()))
                    .child(
                        div()
                            .text_size(text::META)
                            .text_color(theme.foreground)
                            .child(SharedString::from(clip(&commit.subject, 44))),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .text_size(text::MICRO)
                            .text_color(theme.faint)
                            .child(SharedString::from(commit.short.clone()))
                            .child(SharedString::from(commit.author.clone()))
                            .child(SharedString::from(commit.when.clone())),
                    )
            }))
            .into_any_element()
    }
}

fn fact(theme: &Theme, label: &str, value: &str) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(1.0))
        .child(
            div()
                .text_size(text::MICRO)
                .text_color(theme.faint)
                .child(SharedString::from(label.to_string())),
        )
        .child(
            div()
                .text_size(text::UI)
                .text_color(theme.foreground)
                .child(SharedString::from(if value.is_empty() {
                    "—".to_string()
                } else {
                    value.to_string()
                })),
        )
}

fn blank(theme: &Theme, title: &str, body: &str) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(px(4.0))
        .p(px(24.0))
        .child(
            div()
                .text_size(text::UI)
                .text_color(theme.foreground)
                .child(SharedString::from(title.to_string())),
        )
        .child(
            div()
                .text_size(text::MICRO)
                .text_color(theme.faint)
                .child(SharedString::from(body.to_string())),
        )
}
