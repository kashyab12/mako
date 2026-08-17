//! The composer.
//!
//! Built on `gpui-component`'s `InputState`, which brings the things a text
//! field has to get right and which are miserable to reimplement: a blinking
//! cursor that pauses when the window deactivates, selection, word movement,
//! undo grouped by pause, and IME. Auto-grow is configured rather than
//! measured by hand.
//!
//! It owns the whole card — field, toolbar, banners, and the hint line — and
//! the model and effort pickers are handed in rather than rebuilt, so the
//! shell keeps subscribing to them directly.

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{
    div, px, App, Context, Entity, EventEmitter, FocusHandle, Focusable, SharedString, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::divider::Divider;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::{IconName, Sizable};

use crate::effort::EffortPicker;
use crate::model_picker::ModelPicker;
use crate::rpc::Queue;
use crate::theme::{space, text, Theme};
use crate::ui::lit_top;

/// What the shell should do with a committed draft.
pub struct Submit {
    pub text: String,
    /// `None` when the agent is idle; otherwise how Pi should queue it.
    pub queue: Option<Queue>,
}

/// The user asked to stop the running turn.
pub struct Abort;

pub struct Composer {
    pub input: Entity<InputState>,
    theme: Theme,
    model_picker: Entity<ModelPicker>,
    effort_picker: Entity<EffortPicker>,
    /// Drafts keyed by session file.
    ///
    /// Switching sessions to check something and coming back should not cost
    /// you the paragraph you were part-way through. Kept in memory only: a
    /// draft is a thought in progress, not a document, and one that outlives
    /// the window would be a surprise rather than a courtesy.
    drafts: HashMap<String, String>,
    session: Option<String>,
    streaming: bool,
    compacting: bool,
    retrying: Option<(u32, u32)>,
    queued: usize,
    focused: bool,
}

impl EventEmitter<Submit> for Composer {}
impl EventEmitter<Abort> for Composer {}

impl Composer {
    pub fn new(
        theme: Theme,
        model_picker: Entity<ModelPicker>,
        effort_picker: Entity<EffortPicker>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                // One row at rest, twenty before it scrolls: enough for a
                // paragraph of instruction without the field eating the
                // transcript it belongs to.
                .auto_grow(1, 20)
                .placeholder("Ask Mako to change something")
        });

        cx.subscribe_in(
            &input,
            window,
            |composer, _state, event: &InputEvent, window, cx| match event {
                // Enter submits. Shift-Enter is `secondary` and inserts a
                // newline instead, which the input handles on its own.
                InputEvent::PressEnter { secondary } => {
                    if !secondary {
                        composer.submit(None, window, cx);
                    }
                }
                InputEvent::Change => {
                    composer.remember_draft(cx);
                    cx.notify();
                }
                InputEvent::Focus => {
                    composer.focused = true;
                    cx.notify();
                }
                InputEvent::Blur => {
                    composer.focused = false;
                    cx.notify();
                }
                _ => {}
            },
        )
        .detach();

        Self {
            input,
            theme,
            model_picker,
            effort_picker,
            drafts: HashMap::new(),
            session: None,
            streaming: false,
            compacting: false,
            retrying: None,
            queued: 0,
            focused: false,
        }
    }

    /// Mirror the session's status so the composer can say what it is doing.
    pub fn set_status(
        &mut self,
        streaming: bool,
        compacting: bool,
        retrying: Option<(u32, u32)>,
        queued: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.streaming == streaming
            && self.compacting == compacting
            && self.retrying == retrying
            && self.queued == queued
        {
            return;
        }
        // The placeholder is the clearest statement of what pressing Enter will
        // now do, and it changes the moment the agent starts moving.
        if self.streaming != streaming {
            let hint = if streaming {
                "Steer the current turn…"
            } else {
                "Ask Mako to change something"
            };
            self.input.update(cx, |state, cx| {
                state.set_placeholder(hint, window, cx);
            });
        }
        self.streaming = streaming;
        self.compacting = compacting;
        self.retrying = retrying;
        self.queued = queued;
        cx.notify();
    }

    /// Swap in the draft belonging to whichever session just became active.
    pub fn set_session(
        &mut self,
        session: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session == session {
            return;
        }
        self.remember_draft(cx);
        self.session = session;
        let restored = self
            .session
            .as_ref()
            .and_then(|key| self.drafts.get(key))
            .cloned()
            .unwrap_or_default();
        self.input.update(cx, |state, cx| {
            state.set_value(restored, window, cx);
        });
        cx.notify();
    }

    fn remember_draft(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.session.clone() else {
            return;
        };
        let value = self.input.read(cx).value().to_string();
        if value.is_empty() {
            self.drafts.remove(&key);
        } else {
            self.drafts.insert(key, value);
        }
    }

    /// Commit the draft. `queue` overrides the default choice of how to send.
    pub fn submit(
        &mut self,
        queue: Option<Queue>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = self.input.read(cx).value().to_string();
        if value.trim().is_empty() {
            return;
        }
        self.input.update(cx, |state, cx| {
            state.set_value("", window, cx);
        });
        if let Some(key) = self.session.clone() {
            self.drafts.remove(&key);
        }
        // Typing during a turn means "do this too", so the default while
        // streaming is to steer rather than to fail — Pi rejects a bare prompt
        // in that state, and the message would otherwise vanish.
        let queue = queue.or(self.streaming.then_some(Queue::Steer));
        cx.emit(Submit { text: value, queue });
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme.clone();
        let ready = !self.is_empty(cx);
        let streaming = self.streaming;

        div()
            .flex_none()
            .flex()
            .flex_col()
            .items_center()
            .px(px(28.0))
            .pb(px(14.0))
            .pt(px(4.0))
            .child(
                div()
                    .w_full()
                    .max_w(space::COLUMN)
                    .flex()
                    .flex_col()
                    .children(self.banners(&theme))
                    .child(
                        div()
                            .rounded(space::RADIUS_XL)
                            .bg(theme.surface)
                            .border_1()
                            .border_color(if self.focused {
                                theme.border
                            } else {
                                theme.hairline
                            })
                            .overflow_hidden()
                            .shadow_lg()
                            .child(lit_top(&theme))
                            .child(
                                div()
                                    .px(px(13.0))
                                    .py(px(9.0))
                                    .text_size(text::BODY)
                                    // `appearance(false)` drops the library's
                                    // own border and fill so the field inherits
                                    // the card's frame instead of drawing a
                                    // second one inside it.
                                    .child(Input::new(&self.input).appearance(false)),
                            )
                            .child(Divider::horizontal())
                            .child(self.toolbar(&theme, ready, streaming, cx)),
                    )
                    .child(self.hint(&theme)),
            )
    }
}

impl Composer {
    /// What the agent is doing that is neither idle nor answering.
    fn banners(&self, theme: &Theme) -> Vec<gpui::AnyElement> {
        let mut out = Vec::new();

        if self.compacting {
            out.push(banner(theme, "Compacting the conversation…").into_any_element());
        }
        if let Some((attempt, max)) = self.retrying {
            out.push(
                banner(
                    theme,
                    format!("Retrying after a provider error — attempt {attempt} of {max}"),
                )
                .into_any_element(),
            );
        }
        if self.queued > 0 {
            let label = if self.queued == 1 {
                "1 message queued".to_string()
            } else {
                format!("{} messages queued", self.queued)
            };
            out.push(
                div()
                    .mb(px(6.0))
                    .flex()
                    .items_center()
                    .gap(px(7.0))
                    .px(px(4.0))
                    .text_size(text::SMALL)
                    .text_color(theme.faint)
                    .child(
                        div()
                            .rounded_full()
                            .bg(theme.foreground.opacity(0.10))
                            .px(px(6.0))
                            .text_color(theme.muted)
                            .child(SharedString::from(label)),
                    )
                    .child("will be sent when this turn ends")
                    .into_any_element(),
            );
        }

        out
    }

    fn toolbar(
        &self,
        theme: &Theme,
        ready: bool,
        streaming: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .gap(px(2.0))
            .px(px(6.0))
            .py(px(5.0))
            .child(self.model_picker.clone())
            .child(self.effort_picker.clone())
            .child(div().flex_1())
            // Stop is its own control while a turn runs, rather than the send
            // button changing meaning: with steering, sending and stopping are
            // both live at once and both are things you might want.
            .when(streaming, |row| {
                row.child(
                    Button::new("composer-stop")
                        .ghost()
                        .xsmall()
                        .icon(IconName::CircleX)
                        .tooltip("Stop this turn  ⎋")
                        .on_click(cx.listener(|_composer, _event, _window, cx| {
                            cx.emit(Abort);
                        })),
                )
            })
            .child(
                Button::new("composer-send")
                    .when(ready, |button| button.primary())
                    .when(!ready, |button| button.ghost())
                    .small()
                    .rounded(gpui_component::button::ButtonRounded::Large)
                    .icon(if streaming {
                        // A different glyph, because it does a different thing:
                        // this joins the turn already in flight.
                        IconName::Redo2
                    } else {
                        IconName::ArrowUp
                    })
                    .tooltip(if streaming {
                        "Steer the turn  ↩   ·   ⌘↩ to queue for after"
                    } else {
                        "Send  ↩"
                    })
                    .on_click(cx.listener(|composer, _event, window, cx| {
                        composer.submit(None, window, cx);
                    })),
            )
    }

    /// One quiet line, and only while the composer is at rest.
    ///
    /// A permanent row of key chips reads as clutter the moment you have
    /// learned them, which is after the first session — so it fades out the
    /// instant the field is touched rather than staying to be proud of itself.
    fn hint(&self, theme: &Theme) -> impl IntoElement {
        let at_rest = !self.focused && self.queued == 0;

        div()
            .h(px(16.0))
            .mt(px(6.0))
            .px(px(4.0))
            .flex()
            .items_center()
            .gap(px(5.0))
            .text_size(text::MICRO)
            .text_color(theme.faint)
            .when(!at_rest, |line| line.opacity(0.0))
            .child(if self.streaming {
                "Enter steers this turn · ⌘↩ queues it for after"
            } else {
                "Enter sends · ⇧↩ for a new line"
            })
            .child(div().flex_1())
            .child("⌘K")
    }
}

fn banner(theme: &Theme, label: impl Into<SharedString>) -> impl IntoElement {
    div()
        .mb(px(6.0))
        .flex()
        .items_center()
        .gap(px(7.0))
        .rounded(space::RADIUS)
        .bg(theme.raised)
        .px(px(9.0))
        .py(px(5.0))
        .text_size(text::META)
        .text_color(theme.muted)
        .child(div().size(px(4.0)).rounded_full().bg(theme.caution))
        .child(label.into())
}
