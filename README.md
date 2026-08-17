# Pi Desk

A desktop surface for the Pi coding agent: chat sessions, the session tree, and
the working diff. Pi is the only harness — no other CLI is wrapped, and models
come from whatever Pi already has authenticated.

## Run

```bash
npm install
npm run desktop     # Vite + Electron against your real ~/.pi/agent
```

For UI work without an agent:

```bash
npm run dev
open http://127.0.0.1:5173/?mock
```

## What's here

**Composer.** Model picker showing context window, price per million tokens,
and whether a model reasons or takes images — with favorites and fuzzy search.
Reasoning effort offers only the levels the selected model actually supports,
read from Pi's own per-model metadata. `/` opens Pi's registered slash
commands. While a turn is running, Enter steers it and ⌘↩ queues a follow-up.

**Transcript.** No bubbles and no avatars. User turns carry a left rule,
assistant turns are plain prose, and tool calls collapse to one line each —
`edit` renders an inline diff, `bash` renders the command and its output.
Reasoning is a disclosure, not a wall of text.

**References.** `@` opens a fuzzy picker over the workspace's git-tracked
files; `$` opens the skills Pi has loaded; `/` opens Pi's registered commands.
All three render as inline chips in the composer and read back as chips in the
transcript, where a file chip opens the file.

**Inspector.** *Changes* is the working diff via Pierre. *Context* is what the
agent has in hand right now — files it read or edited, skills it can reach for,
tools that are live, and how much of the context window is spent. *History* is
your turns as rewind points, with alternate takes where you branched.

**Sidebar.** Scope it to this project or to every project Pi has ever run in,
and group by recency or by project. Groups collapse; search reaches project
names, so typing a repo name finds sessions inside it without switching scope
first.

**Turn navigator.** A tick per question down the right edge of the transcript.
Hover to read a question back without moving the view, click to jump, or step
with ⌘↑ / ⌘↓.

**Everywhere.** ⌘K reaches every command, model, and session. Every shortcut in
the app is a row in one command registry.

## Performance

Streaming is the design constraint. The host sends only the in-flight message
on the hot path and coalesces bursts to one flush per frame; the renderer
subscribes through selectors, so a token re-renders one turn rather than the
window. Message identity is reconciled across host updates, so a tool result
re-renders the one turn that changed instead of re-parsing every turn's
markdown. The session list is virtualized and composited on the GPU, offscreen
turns are skipped with `content-visibility`, and the diff engine is code-split
out of the boot path.

## Extending it

Commands, slots, tool views, and inspector panels are all registries in
`src/extend/`. Everything the desk ships is registered through the same public
API, so a plugin can add — or replace — any of it. See `AGENTS.md`.

## Reference clones

`ignore/` is gitignored study material only: DeepSeek Harness, Pierre, T3 Code,
ORCA, Codex, and Zed. Do not import from it.

## Opus / thinking signatures

If Anthropic returns `Invalid signature in thinking block`, Pi is replaying a
thinking block the API will not accept — common after a mid-session model
switch or a resumed Opus turn. Start a new session, or turn thinking off, then
continue. It is not a Pi Desk bug.
