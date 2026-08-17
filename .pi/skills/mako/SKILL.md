---
name: mako
description: How to modify Mako itself — the desktop app you are running inside. Covers the codebase layout, which edits appear live without a restart and which do not, and the design and performance rules the codebase holds itself to. Use whenever the task is to change Mako's own interface or behaviour.
---

# Modifying Mako

You are running inside Mako, and this session is pointed at Mako's own source.
Edits you make here change the window you are being read in.

## The hot-reload contract

Read this before you plan any change — it determines whether the user sees your
work immediately or not at all.

| You edit | What happens |
| --- | --- |
| `src/**/*.tsx`, `src/**/*.ts` | Vite hot-replaces the module and React Fast Refresh swaps the component **in place**. No reload. Component state, the open session, and the scroll position all survive. |
| `src/index.css` | Applied instantly. No reload, no flash. |
| `electron/**` | **Nothing happens.** This is the main process. It needs `npm run build:electron` and a full app restart. Say so explicitly when you touch it. |
| `package.json`, `vite.config.ts` | Needs the dev server restarted. |

Two consequences worth planning around:

- **Prefer the renderer.** If a change can be made in `src/` rather than
  `electron/`, make it there — the user sees it in under a second instead of
  after a restart that loses their session.
- **Fast Refresh has one rule you can break by accident.** A module that
  exports a React component *and* something else (a constant, a hook, a helper)
  falls back to a full reload instead of a component swap. Keep component files
  exporting components.

If you must touch `electron/`, finish the renderer work first so the user has
something to look at, and tell them plainly that a restart is required and why.

## Layout

```
electron/          main process — needs a restart
  main.ts          window, IPC handlers, app lifecycle
  host.ts          the Pi SDK wrapper; all agent I/O goes through here
  shared.ts        the wire contract between main and renderer
  preload.ts       the contextBridge surface
src/
  components/
    shell/         title bar, status bar, the app frame
    rail/          the session sidebar
    transcript/    the conversation — exchanges, tool rows, markdown
    composer/      the input, model/effort pickers, mentions, attachments
    inspector/     the right panel — changes, context, history
    palette/       ⌘K
    ui/            the shared kit; `kit.tsx` is the primitives
  state/           zustand stores — `session.ts` is the big one
  lib/             pure helpers; no React, no IPC
  extend/          the plugin registries (commands, slots, tool views)
  desk/            command definitions and app-level wiring
```

Two rules the structure depends on:

- `src/lib/` is pure. No React, no IPC, no DOM. If you need a helper for a
  component, it goes here only if it would still make sense in a test.
- Everything the app ships is registered through the same public API in
  `src/extend/` that a plugin would use. If you add a command, add it the way a
  plugin would.

## Design rules

These are not preferences. Breaking them is what makes the app look generated.

**Colour.** One achromatic ramp. Hue appears *only* where it carries meaning —
diff added/removed, error, caution. There is no brand colour; the accent is
lightness, not hue. Never introduce a coloured accent, a gradient wash, or a
purple anything.

**Type.** Geist for the interface, the platform monospace for code. The scale
is in `src/index.css`. No all-caps micro-labels with letterspacing — that is
the single clearest tell of a generated interface, and it costs legibility at
these sizes for nothing.

**Elevation** is a step on the ramp, not a shadow. `background` → `surface` →
`raised`. Shadows are reserved for things that genuinely float (popovers, the
composer card).

**Density.** This is an instrument, not a landing page. Prefer one line over
two. If a row can carry its meaning in one line, it must.

**Copy.** Sentence case. Say what the thing does, not that it exists. Empty
states say what this is, why it is empty, and how to start. Error messages say
what happened and what to do about it. Cut every word that is not doing work.

## Motion rules

Motion is judged by how often it is seen.

- **100+ times a day** (⌘K, keyboard-driven anything): no animation at all. The
  command palette is deliberately unanimated; do not "improve" it.
- **Occasional** (thread switch, modal, toast): 150–250ms, `--ease-out`.
- Never `ease-in` on UI. It delays the first frame, which is the frame the eye
  is on.
- Never animate from `scale(0)`. Start at `0.95` with opacity — nothing in the
  real world appears from nothing.
- Popovers scale from their trigger, not their centre. The Radix
  `--radix-*-transform-origin` variable is already wired for this.
- Only `transform` and `opacity`. Anything else costs layout every frame, and
  this window is often animating while tokens stream.

The curves and durations are tokens in `src/index.css` (`--ease-out`,
`--duration-press`, …). Use them; do not invent new ones inline.

## Performance rules

Streaming is the constraint everything else bends around. A token arrives every
few milliseconds and must cost one turn's re-render, not the window's.

- Subscribe through selectors (`useSession((s) => s.thing)`), never to the whole
  store. Subscribing to `meta` re-renders on every token-count update.
- Message identity is reconciled across host updates so a tool result
  re-renders the one turn that changed instead of re-parsing every turn's
  markdown. Do not replace message objects wholesale.
- Long lists are virtualized. If you add one, virtualize it.
- Offscreen turns are skipped with `content-visibility`. Keep `contain-turn` on
  anything that repeats down the transcript.
- The hot path in `electron/host.ts` sends only the in-flight message and
  coalesces bursts to one flush per frame. Do not add a full-state send to it.

## Working here

- `npm run typecheck` must pass. It is fast; run it before you say you are done.
- Match the surrounding code's comment density. Comments here explain *why* a
  decision was made, not what the line does. If a line is obvious, say nothing.
- Make the change the user asked for. If you notice something else wrong,
  mention it — do not fix it silently in the same edit.
- When you finish, say which files changed and whether the user needs to
  restart. If everything was in `src/`, say it is already applied.
