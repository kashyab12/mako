//! The model picker.
//!
//! Everything Pi already knows about a model is on the row — the provider it
//! comes from, its context window, whether it reasons — so choosing does not
//! require leaving the composer to go read a docs page.
//!
//! Grouped by provider and filtered by a real search field, because a fleet of
//! forty models across six providers is the normal case, not the exotic one.

use gpui::prelude::*;
use gpui::{
    div, px, App, Context, Corner, Entity, EventEmitter, MouseButton, SharedString, Window,
};
use gpui_component::input::{Input, InputState};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::popover::Popover;
use gpui_component::Sizable;

use crate::session::ModelInfo;
use crate::theme::{space, text, Theme};
use crate::ui::clip;

pub struct ModelPicker {
    models: Vec<ModelInfo>,
    current: ModelInfo,
    search: Entity<InputState>,
    theme: Theme,
}

/// Raised when a model is chosen. Carries the routing key Pi expects.
pub struct SelectModel {
    pub provider: String,
    pub id: String,
}

impl EventEmitter<SelectModel> for ModelPicker {}

impl ModelPicker {
    pub fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));

        // Re-render on every keystroke so the list narrows as it is typed.
        cx.subscribe(&search, |_picker, _state, _event: &gpui_component::input::InputEvent, cx| {
            cx.notify();
        })
        .detach();

        Self {
            models: Vec::new(),
            current: ModelInfo::default(),
            search,
            theme,
        }
    }

    pub fn set_models(&mut self, models: Vec<ModelInfo>, cx: &mut Context<Self>) {
        self.models = models;
        cx.notify();
    }

    pub fn set_current(&mut self, current: ModelInfo, cx: &mut Context<Self>) {
        self.current = current;
        cx.notify();
    }

    /// Models matching the search, in provider order.
    fn matches(&self, cx: &App) -> Vec<ModelInfo> {
        let needle = self.search.read(cx).value().to_lowercase();
        let mut found: Vec<ModelInfo> = self
            .models
            .iter()
            .filter(|model| {
                needle.is_empty()
                    || model.name.to_lowercase().contains(&needle)
                    || model.provider.to_lowercase().contains(&needle)
                    || model.id.to_lowercase().contains(&needle)
            })
            .cloned()
            .collect();

        // Provider first, then name: the list should read as a catalogue
        // rather than as whatever order the host happened to return.
        found.sort_by(|a, b| {
            a.provider
                .cmp(&b.provider)
                .then_with(|| a.name.cmp(&b.name))
        });
        found
    }
}

/// `128K` from a raw context window.
fn context_label(tokens: u64) -> String {
    if tokens == 0 {
        String::new()
    } else if tokens >= 1_000_000 {
        format!("{:.0}M ctx", tokens as f64 / 1_000_000.0)
    } else {
        format!("{}K ctx", tokens / 1_000)
    }
}

impl Render for ModelPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();
        let current = self.current.clone();
        let rows = self.matches(cx);
        let search = self.search.clone();
        let picker = cx.entity();

        let label = if current.name.is_empty() {
            "Select model".to_string()
        } else {
            current.name.clone()
        };

        Popover::new("model-picker")
            .anchor(Corner::BottomLeft)
            // The trigger has to be `Selectable` so the popover can reflect
            // its own open state back onto it; the library's Button is, and a
            // bare Div is not.
            .trigger(
                Button::new("model-trigger")
                    .ghost()
                    .xsmall()
                    .label(SharedString::from(format!("{label}  ▾"))),
            )
            .content(move |_state, _window, _cx| {
                let theme = theme.clone();
                let picker = picker.clone();

                div()
                    .w(px(340.0))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .border_b_1()
                            .border_color(theme.hairline)
                            .p(px(6.0))
                            .child(Input::new(&search).appearance(false)),
                    )
                    .child(
                        div()
                            .id("model-list")
                            .max_h(px(320.0))
                            .overflow_y_scroll()
                            .p(px(4.0))
                            .children(rows.iter().enumerate().map(|(index, model)| {
                                let selected = model.provider == current.provider
                                    && model.id == current.id;
                                // A heading whenever the provider changes, so
                                // the list is scannable by where a model comes
                                // from rather than only by its name.
                                let heading = index == 0
                                    || rows[index - 1].provider != model.provider;
                                let picker = picker.clone();
                                let provider = model.provider.clone();
                                let id = model.id.clone();
                                let theme = theme.clone();

                                div()
                                    .when(heading, |column| {
                                        column.child(
                                            div()
                                                .px(px(6.0))
                                                .pt(px(6.0))
                                                .pb(px(2.0))
                                                .text_size(text::MICRO)
                                                .text_color(theme.faint)
                                                .child(SharedString::from(
                                                    model.provider.clone(),
                                                )),
                                        )
                                    })
                                    .child(
                                        div()
                                            .id(("model", index))
                                            .flex()
                                            .items_center()
                                            .gap(px(8.0))
                                            .rounded(space::RADIUS)
                                            .px(px(6.0))
                                            .py(px(4.0))
                                            .when(selected, |row| row.bg(theme.selected()))
                                            .hover(|style| style.bg(theme.hover()))
                                            .on_mouse_down(
                                                MouseButton::Left,
                                                move |_event, _window, cx| {
                                                    picker.update(cx, |_picker, cx| {
                                                        cx.emit(SelectModel {
                                                            provider: provider.clone(),
                                                            id: id.clone(),
                                                        });
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
                                                        &model.name,
                                                        34,
                                                    ))),
                                            )
                                            .when(model.reasoning, |row| {
                                                row.child(
                                                    div()
                                                        .text_size(text::MICRO)
                                                        .text_color(theme.faint)
                                                        .child("reasons"),
                                                )
                                            })
                                            .child(
                                                div()
                                                    .text_size(text::MICRO)
                                                    .text_color(theme.faint)
                                                    .child(SharedString::from(context_label(
                                                        model.context_window,
                                                    ))),
                                            ),
                                    )
                            })),
                    )
            })
    }
}
