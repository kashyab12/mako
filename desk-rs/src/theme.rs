//! The palette and the glass.
//!
//! Carried over verbatim from the Electron desk, because the decisions behind
//! it were the expensive part: a strictly achromatic ramp, hue reserved for
//! diff and error semantics, elevation expressed as steps on the ramp rather
//! than as shadow.
//!
//! The glass is where the two platforms genuinely differ. CSS gives every
//! element `backdrop-filter`, so a popover can blur its siblings. GPUI has no
//! per-element backdrop blur; what it has is
//! `WindowBackgroundAppearance::Blurred`, which blurs whatever is *behind the
//! window*. So the effect is built the other way around: the window itself is
//! translucent and vibrant, panels are layered translucent fills over it, and
//! the specular top edge — the thing that actually reads as glass — is drawn
//! as a one-pixel highlight rather than filtered.

use gpui::{hsla, Hsla};

/// A step on the neutral ramp. `l` is lightness in the 0..1 range.
fn gray(l: f32, a: f32) -> Hsla {
    hsla(0.0, 0.0, l, a)
}

pub struct Theme {
    pub background: Hsla,
    pub surface: Hsla,
    pub raised: Hsla,
    pub foreground: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,

    pub hairline: Hsla,
    pub border: Hsla,

    /// The accent is light, not coloured — selection reads as "brighter".
    pub accent: Hsla,

    pub added: Hsla,
    pub removed: Hsla,
    pub caution: Hsla,

    /// Fill for a panel floating over the vibrant window background.
    pub glass: Hsla,
    /// The specular highlight along a glass panel's top edge.
    pub lit_edge: Hsla,
}

impl Theme {
    pub fn dark() -> Self {
        Self {
            background: gray(0.145, 1.0),
            surface: gray(0.190, 1.0),
            raised: gray(0.238, 1.0),
            foreground: gray(0.935, 1.0),
            muted: gray(0.685, 1.0),
            faint: gray(0.530, 1.0),

            hairline: gray(1.0, 0.10),
            border: gray(1.0, 0.13),

            accent: gray(0.935, 1.0),

            // Desaturated on purpose: a diff should read as information, not
            // as decoration.
            added: hsla(150.0 / 360.0, 0.42, 0.62, 1.0),
            removed: hsla(6.0 / 360.0, 0.62, 0.60, 1.0),
            caution: hsla(45.0 / 360.0, 0.45, 0.64, 1.0),

            // Translucent so the vibrant window shows through it.
            glass: gray(0.190, 0.82),
            lit_edge: gray(1.0, 0.07),
        }
    }

    pub fn light() -> Self {
        Self {
            background: gray(0.974, 1.0),
            surface: gray(1.0, 1.0),
            raised: gray(0.948, 1.0),
            foreground: gray(0.205, 1.0),
            muted: gray(0.475, 1.0),
            faint: gray(0.620, 1.0),

            hairline: gray(0.0, 0.09),
            border: gray(0.0, 0.12),

            accent: gray(0.205, 1.0),

            added: hsla(150.0 / 360.0, 0.45, 0.38, 1.0),
            removed: hsla(6.0 / 360.0, 0.60, 0.45, 1.0),
            caution: hsla(45.0 / 360.0, 0.50, 0.42, 1.0),

            glass: gray(1.0, 0.78),
            lit_edge: gray(1.0, 0.60),
        }
    }
}

/// Motion, matched to the web build so the two feel like one product.
pub mod motion {
    /// Press feedback.
    pub const PRESS_MS: u64 = 120;
    /// Tooltips and small popovers.
    pub const TOOLTIP_MS: u64 = 140;
    /// Menus and dropdowns.
    pub const MENU_MS: u64 = 180;
    /// Panels.
    pub const PANEL_MS: u64 = 240;
}
