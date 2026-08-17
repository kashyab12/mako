# Pi Desk, native (GPUI)

A native front end for the Pi agent, built on [GPUI](https://crates.io/crates/gpui)
and [gpui-component](https://github.com/longbridge/gpui-component).

## This does not build on this machine yet

GPUI compiles its Metal shaders during `cargo build`, using `xcrun metal`.
That tool ships **only with full Xcode**, not with the Command Line Tools. This
machine has CLT alone:

```
$ xcode-select -p
/Library/Developer/CommandLineTools
$ xcrun -f metal
xcrun: error: unable to find utility "metal", not a developer tool or in PATH
```

`cargo check` fails too, because the failure is in a build script rather than
in type checking — so none of this crate has been compiled or verified.

To unblock:

```bash
# Install Xcode from the App Store (~10 GB), then point the toolchain at it:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
cargo run
```

## Why the agent stays in its own process

Pi is a TypeScript package, so a Rust binary cannot call it directly. It does
not need to: Pi ships an RPC mode that speaks JSONL over stdio and is
documented as being for "embedding the agent in other applications, IDEs, or
custom UIs". `src/rpc.rs` spawns `pi --mode rpc` and talks to it.

The protocol covers essentially the whole surface the Electron desk uses:
`prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`,
`get_entries`, `get_tree`, models, thinking levels, `compact`, session
switching, `get_commands`, stats — and images on `prompt`.

One real gap: there is `fork` but no `navigate_tree`, so rewind-in-place needs
different semantics here than in the Electron build.

## What is here

| File | State |
| --- | --- |
| `src/rpc.rs` | RPC client: spawn, strict JSONL framing, command/event plumbing |
| `src/theme.rs` | The palette and glass, carried over from the web build |
| `src/main.rs` | Window shell with vibrancy |

Written but **not compiled**, for the reason above. Treat it as a reviewed
starting point, not as working software.

## The glass is built differently here

CSS gives every element `backdrop-filter`, so a popover can blur its siblings.
GPUI has no per-element backdrop blur. What it has is
`WindowBackgroundAppearance::Blurred`, which blurs what is behind the *window*.

So the composition inverts: the window is the vibrant surface, panels are
translucent fills layered over it, and the specular top edge that actually
reads as glass is drawn as a highlight rather than filtered. The result can
look the same; it is not built the same way.

## What is not ported

Everything else — transcript, composer, model picker, rail, inspector, git
panel, command palette. `gpui-component` covers a lot of the primitives
(virtualized list and table, markdown, a code editor, dropdowns), which is why
this is tractable rather than from scratch, but it is still a full rebuild of
the product surface.

## Honest advice before going further

The performance argument for this port is weaker than it looks. GPUI wins where
Zed needs it: 120fps over a million-line buffer with custom text shaping. This
app's hot path is one rate-limited markdown parse of one memoized subtree, and
GPUI would not make markdown parsing cheaper.

The real case is **native feel and single-binary distribution**. Both are good
reasons. Just make the decision on those, and note that `gpui` is `0.2.x` and
pre-1.0, with its own README warning of frequent breaking changes.
