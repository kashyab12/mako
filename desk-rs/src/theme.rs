//! The palette, the depth, and the motion constants.
//!
//! Carried over from the web build because the decisions behind it were the
//! expensive part: a strictly achromatic ramp, hue reserved for diff and error
//! semantics, elevation expressed as steps on the ramp rather than as shadow.
//!
//! The glass is where the two platforms genuinely differ. CSS gives every
//! element `backdrop-filter`, so a popover can blur its siblings. GPUI has no
//! per-element backdrop blur; what it has is
//! `WindowBackgroundAppearance::Blurred`, which blurs whatever is *behind the
//! window*. So the effect is built the other way around: the window itself is
//! vibrant, panels are layered translucent fills over it, and the specular top
//! edge — the thing that actually reads as glass — is drawn as a one-pixel
//! highlight rather than filtered out of the backdrop.

use gpui::{hsla, px, Hsla, Pixels};

/// A step on the neutral ramp. `l` is lightness in the 0..1 range.
pub fn gray(l: f32, a: f32) -> Hsla {
    hsla(0.0, 0.0, l, a)
}

#[derive(Clone)]
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
    /// A translucent panel that still needs to be readable over the desktop.
    pub panel: Hsla,
    pub is_dark: bool,
}

impl Theme {
    pub fn dark() -> Self {
        Self {
            background: gray(0.145, 0.86),
            surface: gray(0.190, 0.90),
            raised: gray(0.238, 1.0),
            foreground: gray(0.935, 1.0),
            muted: gray(0.685, 1.0),
            faint: gray(0.530, 1.0),

            hairline: gray(1.0, 0.10),
            border: gray(1.0, 0.14),

            accent: gray(0.935, 1.0),

            // Desaturated on purpose: a diff should read as information, not
            // as decoration.
            added: hsla(150.0 / 360.0, 0.42, 0.62, 1.0),
            removed: hsla(6.0 / 360.0, 0.62, 0.60, 1.0),
            caution: hsla(45.0 / 360.0, 0.45, 0.64, 1.0),

            glass: gray(0.165, 0.72),
            lit_edge: gray(1.0, 0.08),
            panel: gray(0.190, 0.82),
            is_dark: true,
        }
    }

    pub fn light() -> Self {
        Self {
            background: gray(0.974, 0.90),
            surface: gray(1.0, 0.92),
            raised: gray(0.948, 1.0),
            foreground: gray(0.205, 1.0),
            muted: gray(0.475, 1.0),
            faint: gray(0.620, 1.0),

            hairline: gray(0.0, 0.09),
            border: gray(0.0, 0.13),

            accent: gray(0.205, 1.0),

            added: hsla(150.0 / 360.0, 0.45, 0.38, 1.0),
            removed: hsla(6.0 / 360.0, 0.60, 0.45, 1.0),
            caution: hsla(45.0 / 360.0, 0.50, 0.42, 1.0),

            glass: gray(1.0, 0.68),
            lit_edge: gray(1.0, 0.60),
            panel: gray(1.0, 0.80),
            is_dark: false,
        }
    }

    /// Text on top of a filled accent surface.
    pub fn on_accent(&self) -> Hsla {
        if self.is_dark {
            gray(0.12, 1.0)
        } else {
            gray(0.99, 1.0)
        }
    }

    /// A hover fill that works on any step of the ramp.
    pub fn hover(&self) -> Hsla {
        gray(if self.is_dark { 1.0 } else { 0.0 }, 0.05)
    }

    /// The fill for a selected row.
    pub fn selected(&self) -> Hsla {
        gray(if self.is_dark { 1.0 } else { 0.0 }, 0.09)
    }
}

/// The type scale, in one place so density stays consistent.
pub mod text {
    use super::*;

    pub const MICRO: Pixels = px(10.0);
    pub const SMALL: Pixels = px(11.0);
    pub const META: Pixels = px(11.5);
    pub const UI: Pixels = px(12.5);
    pub const BODY: Pixels = px(13.5);
    pub const TITLE: Pixels = px(15.0);
}

/// Spacing and radii, likewise.
pub mod space {
    use super::*;

    pub const RADIUS_SM: Pixels = px(4.0);
    pub const RADIUS: Pixels = px(6.0);
    pub const RADIUS_LG: Pixels = px(10.0);
    pub const RADIUS_XL: Pixels = px(14.0);

    pub const RAIL_WIDTH: Pixels = px(264.0);
    pub const INSPECTOR_WIDTH: Pixels = px(400.0);
    pub const TITLEBAR: Pixels = px(38.0);
    pub const STATUSBAR: Pixels = px(24.0);
    /// The transcript's reading column.
    pub const COLUMN: Pixels = px(760.0);
}
