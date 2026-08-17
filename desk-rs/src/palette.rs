//! The command palette.
//!
//! One surface reaching every verb, every model, and every session — so a
//! capability added once becomes reachable three ways without anyone wiring a
//! menu.
//!
//! Deliberately unanimated. This is opened dozens of times a day by keyboard,
//! and any entrance transition puts a delay between the chord and the caret.
//! Raycast gets this right by having none.

use gpui::prelude::*;
use gpui::{div, px, App, Context, Entity, EventEmitter, MouseButton, SharedString, Window};
use gpui_component::input::{Input, InputEvent, InputState};

use crate::theme::{space, text, Theme};
use crate::ui::clip;

/// What a palette row does when chosen.
#[derive(Clone)]
pub enum Command {
    NewSession,
    Stop,
    ToggleRail,
    ToggleInspector,
    OpenSettings,
    SelectModel { provider: String, id: String },
    OpenSession { path: String },
}

#[derive(Clone)]
pub struct Entry {
    pub section: &'static str,
    pub title: String,
    pub hint: String,
    pub command: Command,
}

pub struct Palette {
    theme: Theme,
    query: Entity<InputState>,
    entries: Vec<Entry>,
    cursor: usize,
    pub open: bool,
}

pub struct Run(pub Command);

impl EventEmitter<Run> for Palette {}

impl Palette {
    pub fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search commands"));

        cx.subscribe(&query, |palette, _state, event: &InputEvent, cx| {
            match event {
                // Narrowing the list must put the highlight back on the first
                // result, or Enter runs something that scrolled out of view.
                InputEvent::Change => {
                    palette.cursor = 0;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => palette.run(cx),
                _ => {}
            }
        })
        .detach();

        Self {
            theme,
            query,
            entries: Vec::new(),
            cursor: 0,
            open: false,
        }
    }

    pub fn set_entries(&mut self, entries: Vec<Entry>) {
        self.entries = entries;
    }

    pub fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = true;
        self.cursor = 0;
        self.query.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    pub fn hide(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        cx.notify();
    }

    pub fn move_cursor(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.matches(cx).len();
        if count == 0 {
            return;
        }
        let next = self.cursor as isize + delta;
        self.cursor = next.rem_euclid(count as isize) as usize;
        cx.notify();
    }

    pub fn run(&mut self, cx: &mut Context<Self>) {
        let matches = self.matches(cx);
        if let Some(entry) = matches.get(self.cursor).cloned() {
            self.open = false;
            cx.emit(Run(entry.command));
            cx.notify();
        }
    }

    /// Rank by a plain substring test. A fuzzy matcher is the wrong trade here:
    /// the corpus is a few hundred short strings the user already half-knows,
    /// and scattered matches mostly produce surprising top hits.
    fn matches(&self, cx: &App) -> Vec<Entry> {
        let needle = self.query.read(cx).value().to_lowercase();
        if needle.is_empty() {
            // With no query, show the verbs only — a wall of every model and
            // session is not a useful resting state.
            return self
                .entries
                .iter()
                .filter(|entry| entry.section == "Actions")
                .cloned()
                .collect();
        }

        let mut scored: Vec<(usize, Entry)> = self
            .entries
            .iter()
            .filter_map(|entry| {
                let haystack = format!("{} {}", entry.title, entry.hint).to_lowercase();
                haystack.find(&needle).map(|at| (at, entry.clone()))
            })
            .collect();
        // Earlier matches first: a title that starts with the query beats one
        // that mentions it halfway through a description.
        scored.sort_by_key(|(at, _)| *at);
        scored.into_iter().map(|(_, entry)| entry).take(60).collect()
    }
}

impl Render for Palette {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }

        let theme = self.theme.clone();
        let rows = self.matches(cx);
        let cursor = self.cursor;
        let palette = cx.entity();

        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .bg(theme.background.opacity(0.55))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|palette, _event, _window, cx| palette.hide(cx)),
            )
            .child(
                div()
                    .mt(px(120.0))
                    .w(px(540.0))
                    .rounded(space::RADIUS_XL)
                    .bg(theme.panel)
                    .border_1()
                    .border_color(theme.border)
                    .shadow_lg()
                    .child(
                        div()
                            .border_b_1()
                            .border_color(theme.hairline)
                            .px(px(10.0))
                            .py(px(8.0))
                            .text_size(text::BODY)
                            .child(Input::new(&self.query).appearance(false)),
                    )
                    .child(
                        div()
                            .id("palette-list")
                            .max_h(px(360.0))
                            .overflow_y_scroll()
                            .p(px(5.0))
                            .children(rows.iter().enumerate().map(|(index, entry)| {
                                let theme = theme.clone();
                                let palette = palette.clone();
                                let command = entry.command.clone();
                                let heading = index == 0
                                    || rows[index - 1].section != entry.section;

                                div()
                                    .when(heading, |column| {
                                        column.child(
                                            div()
                                                .px(px(7.0))
                                                .pt(px(6.0))
                                                .pb(px(2.0))
                                                .text_size(text::MICRO)
                                                .text_color(theme.faint)
                                                .child(entry.section),
                                        )
                                    })
                                    .child(
                                        div()
                                            .id(("entry", index))
                                            .flex()
                                            .items_center()
                                            .gap(px(8.0))
                                            .rounded(space::RADIUS)
                                            .px(px(7.0))
                                            .py(px(5.0))
                                            .when(index == cursor, |row| row.bg(theme.selected()))
                                            .hover(|style| style.bg(theme.hover()))
                                            .on_mouse_down(
                                                MouseButton::Left,
                                                move |_event, _window, cx| {
                                                    palette.update(cx, |palette, cx| {
                                                        palette.open = false;
                                                        cx.emit(Run(command.clone()));
                                                        cx.notify();
                                                    });
                                                },
                                            )
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .text_size(text::UI)
                                                    .text_color(theme.foreground)
                                                    .child(SharedString::from(clip(
                                                        &entry.title,
                                                        46,
                                                    ))),
                                            )
                                            .child(
                                                div()
                                                    .text_size(text::MICRO)
                                                    .text_color(theme.faint)
                                                    .child(SharedString::from(clip(
                                                        &entry.hint,
                                                        22,
                                                    ))),
                                            ),
                                    )
                            })),
                    ),
            )
            .into_any_element()
    }
}
