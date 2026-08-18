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

**Search** — ⌘⇧F searches file contents *and* every conversation about this
project in one query. Case, whole-word and regex switches; a hit in a file
opens it at that line, a hit in a conversation opens that thread.

**Composer** — model picker with context window, price, and whether a model
reasons or takes images. Reasoning effort offers only the levels the selected
model supports. `@` references files, `$` skills, `/` commands. While a turn is
running, Enter steers it and ⌘↩ queues a follow-up.

**Transcript** — no bubbles, no avatars. Tool calls collapse to one line each;
`edit` shows an inline diff, `bash` shows the command and its output. Reasoning
is a disclosure, not a wall of text. A tick per question down the right edge
jumps between turns, or step with ⌘↑ / ⌘↓.

**Inspector** — the working diff, what the agent has in context right now, and
your turns as rewind points. Context is one screen: model and price, how full
the window is, files in play, and every skill on one line each — open one to
read it.

**Sidebar** — wears the project's GitHub avatar, so several open workspaces are
told apart by their logo rather than by identical folder icons. Scope to this project or every project Pi has run in; group by
date or project. Search reaches project names, so typing a repo name finds
sessions inside it.

⌘K reaches every command, model, and session. ⌘P opens a file by name.

## Performance

Streaming is the design constraint. The host sends only the in-flight message
on the hot path and coalesces bursts to one flush per frame. Message identity
is reconciled across updates, so a token re-renders one turn rather than the
window. A background tab sends only the scalars its strip entry needs and hands
over the transcript when you switch to it. The session list is virtualized,
offscreen turns are skipped with `content-visibility`, and the diff engine is
code-split out of the boot path.

## Watching it run

⌘⇧P opens the project's dev server beside the conversation. It lists the npm
scripts this project actually has rather than guessing one, or points at a
server you already have running. Nothing starts on its own — running an
arbitrary script because someone opened a panel is not a thing an editor should
do quietly — and stopping it kills the whole process group, so nothing is left
holding a port. The server's own output is one click away, and opens itself
when the server dies.

## Usage

Settings → Usage adds up what every model has cost you, by day, by model and
by project, read from your own session files. No account and no network: the
numbers are already on disk. It is spend, not billing — a payment method and an
account model are a server and a product decision, not something to imply with
a currency symbol.

## Automations

Saved prompts that can run on their own, defined in `.mako/automations.json`
so they can be committed and shared. Three triggers: **manual**, **on file
change** (globs), and **on commit**. A run opens a background tab — it never
takes the window, because it fired when a file changed, not when you asked.

Every automation arrives switched off, and enabling is local and never written
back: cloning a repository must not start running an agent. A file trigger
waits a minute between runs, so an agent editing the files it watches cannot
loop.

There is deliberately no schedule trigger. An app that is closed cannot fire
one, and an app that is open quietly running jobs against your repository is a
surprise nobody asked for. That wants a daemon, which is a different decision.

## Ports

The preview lists everything listening on the machine, with the ones that look
like development servers first and the background machinery every Mac runs
filtered out. Click one to preview it. The remote half of port forwarding needs
a container to forward from and there is not one; this is the half that gets
used anyway, when the agent starts a backend on one port and a front end on
another.

## Reviewing what the agent wrote

Hover a line in the diff and comment on it, the way you would on a pull
request. Notes collect at the bottom of the panel; **Send to the agent** turns
them into one message — grouped by file, ordered by line, each quoting the line
it is about — and drops it in the composer so you can add a sentence before
sending. Notes survive a reload. The alternative is describing the location in
prose, which is where the friction has always been: `src/net.ts:42` is not a
sentence anyone should have to compose.

## GitHub

The branch's pull request lives under the commit box: state, base, diff size,
whether CI passed, whether anyone approved, and whether it conflicts. No PR yet
and commits to push? One line offers to open one — the agent drafts the title
and body from the diff, you edit them, and nothing is published until you press
the button. Authentication is whatever `gh` already has; if `gh` is missing or
logged out, none of this appears rather than nagging.

## Shipping it

```bash
npm run package    # builds a DMG and a zip into release/
```

Pushing a `v*` tag builds on macOS and Linux and publishes to GitHub releases,
which is also the update feed. The app checks on launch and every six hours,
downloads on its own, and **never installs on its own** — a turn can run for
minutes and touch real files, so the restart is always a click. Builds are
unsigned until certificates exist; they install and update either way, macOS
just asks once on first launch.

## Checking the UI

```bash
MAKO_AUTOMATION=7333 npm run desktop
scripts/probe.sh 'document.querySelectorAll("[data-line]").length'
```

A loopback endpoint that evaluates an expression in the window, so a check can
click a button, measure it, or hover it without taking over the pointer. Off
unless a development build is launched with that variable set.

## When it breaks

A component that throws no longer takes the window with it: you get a screen
that says what happened and offers to retry or reload, and the agent keeps
running either way — it lives in the main process. Unhandled errors, rejections
and a dead renderer are written to `<userData>/crashes` with the app and OS
versions and a trail of the last IPC calls. **Nothing is sent anywhere.**
Settings → Diagnostics lists them and copies one on request.

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
