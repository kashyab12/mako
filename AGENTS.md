# Pi Desk

Pi is the only agent harness. Do not wrap Codex, Claude Code, Cursor, or ORCA CLIs.
Pi already talks to every model those tools use.

`ignore/` is reference-only and gitignored: DeepSeek Harness, Pierre, T3 Code,
ORCA, Codex, and Zed. Study material, never imported.

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
   selectors and call `actions.*`. No component talks to the bridge directly
   except the changes panel, which fetches one diff on demand.

## The hot path

Token streaming must never re-send the session. The host emits `stream` with
only the in-flight message; `messages`, `tree`, and `git` go out only when they
actually change, and every burst is coalesced into one flush per frame. On the
renderer side components subscribe through selectors, so a token wakes the one
turn rendering it — not the rail, the inspector, or the status bar.

Three rules hold this together, and each has a specific failure it prevents:

- **Select the narrowest slice.** `useSession((s) => s.meta)` in the transcript
  re-renders the whole list whenever a token count moves. Take `s.meta?.cwd`.
- **Reconcile message identity** (`src/lib/reconcile.ts`). The host rebuilds
  the entire message array whenever a tool returns, so every object arrives
  new; without reconciliation one tool result re-parses the markdown of every
  turn in the session.
- **Long lists are virtualized, long content uses `content-visibility`.** The
  rail is windowed with `@tanstack/react-virtual`; transcript turns and
  inspector rows carry `.contain-turn` so offscreen work is skipped without
  the fragility of windowing variable-height streaming content.

`useVirtualizer` makes the React Compiler bail out of the component that calls
it, so it stays isolated in `rail/virtual-sessions.tsx`. Keep it there.

## Pi's session tree is not a tree

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
registerInspectorPanel({ id, label, icon, render })           // whole tabs
```

The inspector ships three panels — Changes, Context, History — registered on
exactly the same footing as anything a plugin would add.

Slots are declared in `SlotMap` (`src/extend/slots.ts`) — that table is the
contract for what may render where and with which props. Adding a seam means
adding a key there. Built-in registrations live in `src/desk/builtins.tsx` and
`src/desk/use-desk-commands.ts`.

A command with a `keys` field is automatically live in the palette, in the
keyboard layer, and in any menu that reads the registry. Never add a bare
`keydown` listener for a shortcut.

## The transcript is grouped by exchange

`src/lib/exchanges.ts` folds messages into one question plus everything the
agent did to answer it. Two things depend on that grouping and both were wrong
before it existed: **copy belongs to the whole answer**, not to each fragment
of a long reply, and the turn navigator needs something meaningful to jump
between. The prompt gets its own surface so it is unmistakably the user's.

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
  components; no shadow for elevation — step the surface instead.
- **The ramp is achromatic and the accent is light, not coloured.** Hue is
  spent only where it carries meaning: diff add/remove, error, warning. A
  brand hue is what makes a tool look like a landing page.
- **No uppercase micro-labels.** Section labels are sentence case with no
  letterspacing. Uppercase + tracking at 10px is the most recognisable tell of
  a generated interface and it costs legibility for nothing.
- **Every number carries its noun.** A bare `33%` next to a bare `$6.62` is
  decoration that looks like information. Write `context 141K/400K` and
  `$6.62 spent`.
- Geist for UI, the platform monospace for code. Do not ship a code webfont.
- Entrances are `--ease-out` and under 250ms. Nothing animates from `scale(0)`.
  Anything triggered by keyboard many times a day (the palette) does not
  animate at all.
- Pressable surfaces carry the `pressable` class.

## Product surface

Chat sessions, the Pi session tree, and the current git diff. No worktree
manager.

## Working on the UI

`npm run dev` then open `http://127.0.0.1:5173/?mock` to boot the desk against
fixtures (`src/dev/mock-bridge.ts`) with no agent and no token spend.
`npm run desktop` runs the real thing.
