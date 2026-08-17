//! The icon sheet, compiled into the binary.
//!
//! `gpui-component` names its icons but does not ship them: `IconName::Search`
//! resolves to the string `"icons/search.svg"` and then asks the *application*
//! for that path. With no `AssetSource` registered the lookup fails silently —
//! every icon in the window renders as nothing, buttons included, which is
//! indistinguishable from a layout that never drew. That was the state of this
//! app until now.
//!
//! `include_dir!` embeds the sheet at compile time so a released binary has no
//! runtime dependency on where it was built from, and no directory to lose.

use anyhow::Result;
use gpui::{AssetSource, SharedString};
use std::borrow::Cow;

/// The generated sheet. `scripts/gen-icons.mjs` writes it from the Lucide set
/// already vendored for the web build, so both front ends draw the same glyphs.
static ICONS: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/assets/icons");

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        // Paths arrive as `icons/search.svg`; the embedded tree is rooted at
        // `icons` already, so the prefix is stripped rather than nested.
        let relative = path.strip_prefix("icons/").unwrap_or(path);
        Ok(ICONS
            .get_file(relative)
            .map(|file| Cow::Borrowed(file.contents())))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(ICONS
            .files()
            .map(|file| SharedString::from(format!("icons/{}", file.path().display())))
            .collect())
    }
}
