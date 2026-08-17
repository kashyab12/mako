//! Reasoning effort.
//!
//! Only the levels the *selected model* advertises are offered — Pi reports
//! them per model, so a model that cannot do "max" never shows a dead option.
//! The trigger is a four-bar gauge because effort is ordinal: you should be
//! able to read the current setting without reading a word.

use gpui::prelude::*;
use gpui::{div, px, Context, Corner, EventEmitter, MouseButton, SharedString, Window};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::popover::Popover;
use gpui_component::Sizable;

use crate::theme::{space, text, Theme};

pub struct EffortPicker {
    levels: Vec<String>,
    current: String,
    theme: Theme,
}

pub struct SelectEffort(pub String);

impl EventEmitter<SelectEffort> for EffortPicker {}

/// How many of the four bars are lit. `xhigh` and `max` both fill the gauge —
/// past "high" the distinction is in the label, not the shape.
fn rank(level: &str) -> usize {
    match level {
        "off" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        _ => 4,
    }
}

fn describe(level: &str) -> &'static str {
    match level {
        "off" => "No reasoning tokens. Fastest, cheapest.",
        "minimal" => "A brief look before answering.",
        "low" => "Light reasoning for routine work.",
        "medium" => "Balanced. A good default for real tasks.",
        "high" => "Deliberate. For tricky bugs and design work.",
        "xhigh" => "Extended reasoning. Slow and expensive.",
        _ => "Everything the model has. Reserve for hard problems.",
    }
}

impl EffortPicker {
    pub fn new(theme: Theme) -> Self {
        Self {
            levels: Vec::new(),
            current: String::new(),
            theme,
        }
    }

    pub fn set(&mut self, levels: Vec<String>, current: String, cx: &mut Context<Self>) {
        self.levels = levels;
        self.current = current;
        cx.notify();
    }
}

/// The gauge: bars of increasing height, lit up to the current level.
fn gauge(theme: &Theme, level: &str) -> gpui::Div {
    let lit = rank(level);
    div()
        .flex()
        .items_end()
        .gap(px(1.5))
        .children((0..4).map(|index| {
            div()
                .w(px(2.0))
                .h(px(4.0 + index as f32 * 2.0))
                .rounded(px(1.0))
                .bg(if index < lit {
                    theme.foreground.opacity(0.85)
                } else {
                    theme.foreground.opacity(0.20)
                })
        }))
}

impl Render for EffortPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();
        let current = self.current.clone();
        let levels = self.levels.clone();
        let picker = cx.entity();

        // A model with no reasoning support gets no control at all rather than
        // a disabled one: an inert affordance is worse than an absent one.
        if levels.len() <= 1 {
            return div().into_any_element();
        }

        Popover::new("effort-picker")
            .anchor(Corner::BottomLeft)
            .trigger(
                Button::new("effort-trigger")
                    .ghost()
                    .xsmall()
                    .label(SharedString::from(current.clone()))
                    .dropdown_caret(true),
            )
            .content(move |_state, _window, _cx| {
                let theme = theme.clone();
                let current = current.clone();
                let picker = picker.clone();

                div()
                    .w(px(268.0))
                    .p(px(4.0))
                    .children(levels.iter().enumerate().map(|(index, level)| {
                        let selected = *level == current;
                        let picker = picker.clone();
                        let chosen = level.clone();
                        let theme = theme.clone();

                        div()
                            .id(("effort", index))
                            .flex()
                            .items_start()
                            .gap(px(8.0))
                            .rounded(space::RADIUS)
                            .px(px(8.0))
                            .py(px(6.0))
                            .when(selected, |row| row.bg(theme.selected()))
                            .hover(|style| style.bg(theme.hover()))
                            .on_mouse_down(MouseButton::Left, move |_event, _window, cx| {
                                picker.update(cx, |_picker, cx| {
                                    cx.emit(SelectEffort(chosen.clone()));
                                });
                            })
                            .child(div().pt(px(4.0)).child(gauge(&theme, level)))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .child(
                                        div()
                                            .text_size(text::UI)
                                            .text_color(theme.foreground)
                                            .child(SharedString::from(level.clone())),
                                    )
                                    .child(
                                        div()
                                            .text_size(text::MICRO)
                                            .text_color(theme.faint)
                                            .child(describe(level)),
                                    ),
                            )
                    }))
            })
            .into_any_element()
    }
}
