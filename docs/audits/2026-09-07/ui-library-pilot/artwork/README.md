# Ocean opening revision

The earlier faint procedural wave did not meet the requested visual ambition. After inspecting capy.ai's illustrated scenery and panel composition, the opening now uses an original generated marine engraving, with the existing warm palette applied through CSS. No Capy artwork was copied.

The source PNG is retained here. The application serves `public/artwork/mako-ocean-engraving.webp`, encoded at quality 85, approximately 266KB. The illustration is decorative and hidden from accessibility. The small canvas wake retains its bounded dimensions and scheduling. CSS entrance motion lasts 220ms and is disabled for reduced motion. Detailed water is below the opening controls.

Actual screenshots are in `../screenshots/ocean-opening.png` and `../screenshots/ocean-sidebar.png`. The production-component browser regression page passes, including canvas disposal, document visibility, reduced motion and bounded dimensions. Full lint passes with zero Oxlint diagnostics and the two existing TanStack Virtual ESLint warnings.

## Composer layout correction

The original plate was attached to the shrinking transcript viewport. Growing a draft changed the image crop, scale and horizon position; the empty transcript also inherited bottom-follow scrolling. The scene now belongs to the full agent pane with a fixed bottom inset, and the empty screen uses ordinary scrolling. Composer focus no longer changes its padding or minimum height. The text overlay and textarea retain identical padding.

The browser fixture exercises the actual Transcript and Composer together at 1, 12 and 30 lines, checking unchanged scene and heading coordinates relative to the pane and no focus-height change. Real-host checks measured identical scene bounds and heading position before and after a 12-line draft. Screenshots `composer-stable-empty.png` and `composer-stable-draft.png` show the result. No new continuous animation or palette change was added.
