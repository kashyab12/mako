# Mako

<img src="mako-icons/dark/logomark-1024.png" width="88" align="right" alt="" />

A desktop app for coding agents. Today it runs the
[Pi agent](https://github.com/earendil-works/pi-coding-agent), and models come
from whatever Pi already has authenticated — but the agent sits behind one
adapter (`electron/host.ts`), and nothing above that file names it.

## Run

```bash
npm install
npm run desktop      # Electron against your real ~/.pi/agent
```

UI work without an agent:

```bash
npm run dev
open 'http://127.0.0.1:5173/?mock'
```

## What's here

**Tabs** — several agents at once, each with its own runtime and working
directory. A background tab keeps streaming while you read another one, and
says so with a dot. ⌘T opens one, ⌘1–9 jumps, ⌘-click a thread in the sidebar
opens it beside the current one. **Branch** on any past turn continues that
conversation in a new tab, leaving the original running — which is how you
answer the same question two ways and compare.

**Files** — the left rail switches between your threads and the project. ⌘P
opens any file by name, ⌘⇧E shows the tree. A file opens in place of the
transcript with syntax highlighting, and re-reads itself when the agent edits
it, so what you are looking at is never a stale copy. ⌘↩ in the file finder
puts an `@` reference in the composer instead of opening it.

**Composer** — model picker with context window, price, and whether a model
reasons or takes images. Reasoning effort offers only the levels the selected
model supports. `@` references files, `$` skills, `/` commands. While a turn is
running, Enter steers it and ⌘↩ queues a follow-up.

**Transcript** — no bubbles, no avatars. Tool calls collapse to one line each;
`edit` shows an inline diff, `bash` shows the command and its output. Reasoning
is a disclosure, not a wall of text. A tick per question down the right edge
jumps between turns, or step with ⌘↑ / ⌘↓.

**Inspector** — the working diff, what the agent has in context right now, and
your turns as rewind points.

**Sidebar** — scope to this project or every project Pi has run in; group by
date or project. Search reaches project names, so typing a repo name finds
sessions inside it.

⌘K reaches every command, model, and session.

## Performance

Streaming is the design constraint. The host sends only the in-flight message
on the hot path and coalesces bursts to one flush per frame. Message identity
is reconciled across updates, so a token re-renders one turn rather than the
window. A background tab sends only the scalars its strip entry needs and hands
over the transcript when you switch to it. The session list is virtualized,
offscreen turns are skipped with `content-visibility`, and the diff engine is
code-split out of the boot path.

## Extending it

Commands, slots, tool views, and inspector panels are registries in
`src/extend/`. Everything Mako ships is registered through that same public
API, so a plugin can add or replace any of it. See `AGENTS.md`.

## Notes

`ignore/` is gitignored study material. Don't import from it.

If Anthropic returns `Invalid signature in thinking block`, Pi is replaying a
thinking block the API won't accept — common after a mid-session model switch.
Start a new session, or turn thinking off. Not a Mako bug.

There was a native GPUI rewrite in `desk-rs/`; it was removed at `8c305c0` and
is recoverable from history if it's ever worth revisiting.
