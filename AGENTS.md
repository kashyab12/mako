# Mako

Mako is a meta-harness. Claude Code, Codex, Cursor, Grok, Devin, and OpenCode
are peer providers with provider-owned control and observation transports. No provider
is privileged in public types, bridge names, UI language, continuation, or
session handling.

Mako has no embedded coding-agent runtime. `electron/host.ts` owns only the
workspace and git boundary; every coding agent runs through a provider-owned
process. Never expose Pi as a provider, bridge, IPC namespace, message type,
UI label, or "native" path.

`ignore/` is reference-only and gitignored: DeepSeek Harness, Pierre, T3 Code,
ORCA, Codex, Zed, Superset, OpenCode, macOS Harness, CUA, and Browser Use.
Study material, never imported or edited.

Prior art worth knowing: ORCA's sidebar flattens groups into a `header | item`
row list with a user-selectable group-by, which is what `rail-rows.ts` follows.
Codex's "backtrack" (Esc-Esc) navigates your past prompts to fork from one,
which is what the turn navigator and the History panel are for.

## Layers

One direction of knowledge, no exceptions:

1. **Host** (`electron/`) owns the agent runtime and git. It speaks one wire
   contract, `electron/shared.ts`, and nothing else crosses the boundary.
2. **State** (`src/state/`) is React-free. `store.ts` is the observable;
   `session.ts` applies host events and owns every mutation the UI can make.
3. **Components** (`src/components/`) are presentation. They read through
   selectors and call domain actions in `src/state/`. Components and desk code
   never import `src/lib/bridge.ts`; ESLint enforces that boundary.

## Provider composition

A provider is installed once from `electron/providers/<id>/index.ts`. That
module contributes independent capabilities to `providerHost`: metadata and
model discovery, native and ACP execution, native session emission, accounts,
MCP discovery/writes, and skill roots.
Consumers query those registries; they never maintain another list of provider
ids or branch on all known providers. Provider-specific wire syntax and paths
belong under that provider's directory. A new provider adds one module to
`electron/providers/index.ts`; it does not add switches to shared consumers.

`@mako/sessions` remains the pure native-store layer. Its `SessionProvider`
contract owns discovery, translation, and following without importing Electron
or any provider host capability.

## The hot path

Token streaming must never re-send the session. The host emits `stream` with
only the in-flight message; `messages`, `tree`, and `git` go out only when they
actually change, and every burst is coalesced into one flush per frame. On the
renderer side components subscribe through selectors, so a token wakes the one
turn rendering it — not the rail, the stage strip, or the titlebar's readings.

Three rules hold this together, and each has a specific failure it prevents:

- **Select the narrowest slice.** `useSession((s) => s.meta)` in the transcript
  re-renders the whole list whenever a token count moves. Take `s.meta?.cwd`.
- **Reconcile message identity** (`src/lib/reconcile.ts`). The host rebuilds
  the entire message array whenever a tool returns, so every object arrives
  new; without reconciliation one tool result re-parses the markdown of every
  turn in the session.
- **Long lists are virtualized, long content uses `content-visibility`.** The
  rail is windowed with `@tanstack/react-virtual`; transcript turns and
  surface-panel rows carry `.contain-turn` so offscreen work is skipped
  without the fragility of windowing variable-height streaming content.

`useVirtualizer` makes the React Compiler bail out of the component that calls
it, so it stays isolated in `rail/virtual-sessions.tsx`. Keep it there.

## The built-in runtime's session tree is not a tree

It is a parent-linked chain: every entry is a child of the previous one, so
nesting depth grows once per *entry*, not once per branch. A real session is
345 entries nested 334 deep, with 7 user turns and 45 model/thinking changes.

This has bitten twice. Rendered as written it is a staircase that runs off the
right edge. **Serialized as written it exceeds Electron's contextBridge clone
depth of 1000** and the window dies with a recursion error. The wire format is
therefore a flat `TreeNode[]` carrying `parentId` and `childIds`; never
reintroduce nesting.

`src/lib/thread.ts` is the translation: it collects user turns from the whole
tree, folds settings into the turn they applied to, and expresses real branch
points as alternate "takes" rather than as indentation. Turns are gathered from
the entire tree and not just the live path, because navigating away leaves
earlier turns on an abandoned branch and those are exactly the ones worth
rewinding to — sessions exist whose live path contains no messages at all.

## Extending the desk

Four registries, all in `src/extend/`. Everything the desk itself ships is
registered through them, so nothing built-in is privileged:

```ts
registerCommand({ id, title, section, keys: "mod+j", run })  // palette + keyboard
registerSlot("my-badge", "composer.controls", Component)      // UI seams
registerToolView("bash", { summary, body, icon })             // transcript rows
registerSurface({ id, label, icon, render, minWidth })        // stage companions
```

The stage's surfaces — Changes, Context, History, Files, Terminal —
are all registered through `registerSurface` on exactly the same footing as
anything a plugin would add. One reading surface opens as the right sidebar at
a fixed, draggable width; the independent Terminal dock can remain open below it
at a fixed, draggable height. Neither uses percentage splits. The central workbench
stays mounted under a covering sidebar so transcripts and file tabs keep their state.

Files loaded from the user-data extensions directory are **trusted local UI
extensions**, not sandboxed host plugins. They can read and mutate renderer
state, are bounded by file/contribution limits, and cannot register host
providers. Do not describe them as isolated or safe for third-party code.

Slots are declared in `SlotMap` (`src/extend/slots.ts`) — that table is the
contract for what may render where and with which props. Adding a seam means
adding a key there. Built-in registrations live in `src/desk/builtins.tsx` and
`src/desk/use-desk-commands.ts`.

A command with a `keys` field is automatically live in the palette, in the
keyboard layer, and in any menu that reads the registry. Never add a bare
`keydown` listener for a shortcut.

## The transcript is grouped by exchange

Built-in sessions, native-store threads, and live ACP/app-server sessions all
project into `ChatMessage` and render through `conversation-timeline.tsx`.
Provider-specific headers, permissions, and modes may wrap that timeline; they
must not introduce another transcript renderer.

`src/lib/exchanges.ts` folds messages into one question plus everything the
agent did to answer it. Two things depend on that grouping and both were wrong
before it existed: **copy belongs to the whole answer**, not to each fragment
of a long reply, and the turn navigator needs something meaningful to jump
between. The prompt gets its own surface so it is unmistakably the user's.

## Never lose a paragraph

A draft is the one thing in the desk the user made and cannot get back. Every
other state — the diff, the tree, the token count — is recoverable by asking
again. So the composer clears optimistically, because typing the next thing
should be instant, and `drafts` in `composer.tsx` keeps the text per session so
switching tabs mid-sentence costs nothing.

Restoring a refused send is where this gets subtle, and the trap is timing.
`session.prompt()` does not resolve when the prompt is *accepted*; it awaits
`_runAgentPrompt` and the whole `continue()` loop, so an awaited `send` settles
minutes later, when the answer is done. Restoring a draft on that promise
overwrites the paragraph the user has since typed — losing work in the name of
saving it — and can paint it into whatever session is on screen by then.
Rejection is a *preflight* fact (no model, no key), so read it from the
built-in runtime's `PromptOptions.preflightResult` and settle in one tick, while the composer is
still provably empty. Anything that repaints the textarea later must first
check that the draft is still empty and the session has not changed; otherwise
leave the text in `drafts` and say so.

The same rule covers the quieter losses: `buildPrompt` silently omits an
attachment that is still `pending`, so sending mid-staging drops a file with no
notice, and `clear()` revokes preview URLs — which is why detaching for a
possible restore is separate from discarding for good.

## MCP

Mako owns a redacted, provider-neutral MCP registry. Use the current
`@modelcontextprotocol/sdk` and its latest negotiated protocol (currently
2025-11-25); do not hand-roll legacy SSE framing. Streamable HTTP is the remote
transport, stdio is the local transport, and tool annotations must accurately
state read-only, destructive, idempotent, and open-world behavior. Provider
OAuth remains provider-owned. Never send secret values over IPC, logs, tests,
or registry snapshots.

## Zero lint debt

Every source change must leave both ESLint and Oxlint clean. Run `npm run lint`
before handoff; `npm run lint:anti-slop` must report zero warnings and zero
errors. Do not disable, downgrade, or bypass anti-slop rules. A narrowly scoped
exception is allowed only when the owning external API makes a typed boundary
impossible, and it must include a precise safety invariant plus a regression
test. Existing debt is never a reason to add new debt.

## Git

`ChangesPanel` stages, commits, and pushes; `commit-box.tsx` drafts messages
through `modelRuntime.completeSimple` — deliberately outside the session, so a
utility call does not spend the user's context. The prompt is Zed's, because it
is well tuned, and the diff is truncated per file so one huge generated file
cannot crowd out the change that matters.

Two things to preserve: a repository with **no commits has no HEAD**, so
`diff HEAD` fails in exactly the state where a first commit message is most
wanted — `gitPatch` falls back to the index and then to a file listing. And
push publishes work off the machine, so it stays a separately-labelled
deliberate action and never rides along with a commit.

## Design rules

- Tokens live in `src/index.css` and nowhere else. No literal colors in
  components. Chrome (`--shell`) carries no shadow, ever. Structural workspace
  panes tile edge-to-edge with square edges and 1px dividers; rounded `.card`
  surfaces are reserved for content within a pane. Real shadows exist only on
  floating surfaces (`.overlay-panel`: menus, palette, dialogs).
- **The ramp is warm ember neutrals — red-shifted near-blacks, warm
  off-white text — and stays that quiet.** Ember (`--ember`) is punctuation,
  not brand: the live/working dot, the composer caret, at most one badge.
  Never on links, borders, focus, selection, hover fills, icons at rest, or
  any fill larger than a badge; if two ember moments are visible in one
  pane, one is wrong. Selection and hover are tints of the text colour
  (`--fill-hover` / `--fill-selected`), never the accent. Beyond ember, hue
  appears only where it carries meaning: diff add/remove, error, warning.
- **Three UI type sizes only** — `text-label` (11), `text-ui` (13),
  `text-title` (15) — plus prose (14) and code (12). Weights come off
  Geist's variable axis as 440/530/640 through the standard `font-normal`/
  `font-medium`/`font-semibold` classes. No literal `text-[Npx]` in
  components; eslint enforces both this and the raw-hue ban.
- **No uppercase micro-labels.** Section labels are sentence case with no
  letterspacing. Uppercase + tracking at 10px is the most recognisable tell of
  a generated interface and it costs legibility for nothing.
- **Every number carries its noun.** A bare `33%` next to a bare `$6.62` is
  decoration that looks like information. Write `context 141K/400K` and
  `$6.62 spent`.
- Geist for UI, the platform monospace for code. Do not ship a code webfont.
- Two curves: `--ease-out` for everything that arrives, `--ease-swift` for
  everything that leaves — exits faster than entrances. Entrances stay under
  250ms and nothing animates from `scale(0)`. Anything triggered by keyboard
  many times a day (the palette) does not animate at all.
- Pressable surfaces carry the `pressable` class.

## Product surface

Provider sessions, the built-in runtime's session tree, and the current git
diff. No worktree manager. There is no status bar: the always-on facts live
in the titlebar's right cluster, and the context/cost readings sit beside
the composer, next to the send they price. The rail is the vertical thread
list; horizontal tabs inside the central workbench hold the agent session,
files, and diffs for that thread, never more sessions.

## Working on the UI

`npm run dev` then open `http://127.0.0.1:5173/?mock` to boot the desk against
fixtures (`src/dev/mock-bridge.ts`) with no agent and no token spend.
`npm run desktop` runs the real thing.
