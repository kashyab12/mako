//! The composer.
//!
//! Built on `gpui-component`'s `InputState`, which brings the things a text
//! field has to get right and which are miserable to reimplement: a blinking
//! cursor that pauses when the window deactivates, selection, word movement,
//! undo grouped by pause, and IME. Auto-grow is configured rather than
//! measured by hand — the field grows from one row to twelve, then scrolls.

use gpui::prelude::*;
use gpui::{div, px, App, Context, Entity, EventEmitter, FocusHandle, Focusable, Window};
use gpui_component::input::{Input, InputEvent, InputState};

use crate::theme::text;

pub struct Composer {
    pub input: Entity<InputState>,
}

/// Raised when the user commits the draft.
pub struct Submit(pub String);

impl EventEmitter<Submit> for Composer {}

impl Composer {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                // One row at rest, twelve before it scrolls: enough for a
                // paragraph of instruction without the field eating the
                // transcript it belongs to.
                .auto_grow(1, 12)
                .placeholder("Ask Mako to change something")
        });

        cx.subscribe_in(
            &input,
            window,
            |composer, _state, event: &InputEvent, window, cx| {
                // Enter submits. Shift-Enter is `secondary` and inserts a
                // newline instead, which the input handles on its own.
                if let InputEvent::PressEnter { secondary } = event {
                    if !secondary {
                        composer.submit(window, cx);
                    }
                }
            },
        )
        .detach();

        Self { input }
    }

    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value().to_string();
        if value.trim().is_empty() {
            return;
        }
        self.input.update(cx, |state, cx| {
            state.set_value("", window, cx);
        });
        cx.emit(Submit(value));
    }

    pub fn is_empty(&self, cx: &App) -> bool {
        self.input.read(cx).value().trim().is_empty()
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(13.0))
            .py(px(9.0))
            .text_size(text::BODY)
            // `appearance(false)` drops the library's own border and fill so
            // the field inherits the composer card's frame instead of drawing
            // a second one inside it.
            .child(Input::new(&self.input).appearance(false))
    }
}
