//! Shared element builders.
//!
//! GPUI composes with methods rather than classes, so the equivalent of a
//! utility layer is a set of functions that return a pre-styled `Div`. Keeping
//! them here is what stops density and radius drifting between panels.

use crate::theme::{space, text, Theme};
use gpui::prelude::*;
use gpui::{div, px, Div, Pixels, SharedString};

/// A panel that floats over the vibrant window background.
pub fn panel(theme: &Theme) -> Div {
    div().bg(theme.panel)
}

/// A horizontal hairline, used as a border substitute where a full border
/// would close a shape that should stay open.
pub fn rule(theme: &Theme) -> Div {
    div().h(px(1.0)).w_full().bg(theme.hairline)
}

/// A section label. Sentence case and unremarkable on purpose — uppercase
/// micro-labels with letterspacing are the clearest tell of a generated
/// interface, and they cost legibility at this size for nothing.
pub fn eyebrow(theme: &Theme, label: impl Into<SharedString>) -> Div {
    div()
        .text_size(text::SMALL)
        .text_color(theme.faint)
        .child(label.into())
}

/// A row that highlights on hover, for lists.
pub fn row(theme: &Theme) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .rounded(space::RADIUS)
        .px(px(6.0))
        .py(px(4.0))
        .hover(|style| style.bg(theme.hover()))
}

/// The Mako fin.
///
/// Drawn rather than loaded: at title-bar sizes an SVG asset would need a
/// rasteriser and a cache for a shape that is two curves, and a drawn mark
/// picks up the theme's foreground automatically in both schemes.
///
/// The silhouette is a swept triangle — a vertical trailing edge with the
/// leading edge raked back — approximated here by a rotated square with one
/// rounded corner, which reads correctly from about 12px up.
pub fn fin(theme: &Theme, size: Pixels) -> Div {
    div()
        .size(size)
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .w(size * 0.72)
                .h(size * 0.72)
                .rounded_tl(size * 0.62)
                .bg(theme.foreground.opacity(0.92)),
        )
}

/// The specular top edge that makes a translucent surface read as glass.
/// Drawn rather than filtered, because GPUI has no per-element backdrop blur.
pub fn lit_top(theme: &Theme) -> Div {
    div().h(px(1.0)).w_full().bg(theme.lit_edge)
}

/// Truncate for display. GPUI clips overflow but does not ellipsize, so a
/// label that must not wrap is shortened here instead.
pub fn clip(value: &str, max: usize) -> String {
    let trimmed = value.trim().replace('\n', " ");
    if trimmed.chars().count() <= max {
        return trimmed;
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// `~/projects/thing` from an absolute path.
pub fn workspace_name(cwd: &str) -> String {
    cwd.rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

pub fn format_cost(value: f64) -> String {
    if value <= 0.0 {
        "$0.00".into()
    } else if value < 0.01 {
        "<$0.01".into()
    } else {
        format!("${value:.2}")
    }
}

pub fn format_tokens(count: u64) -> String {
    if count < 1_000 {
        count.to_string()
    } else if count < 1_000_000 {
        format!("{:.0}k", count as f64 / 1_000.0)
    } else {
        format!("{:.1}M", count as f64 / 1_000_000.0)
    }
}
