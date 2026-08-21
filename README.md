<p align="center">
  <img src="mako-icons/dark/logomark-1024.png" width="92" alt="Mako" />
</p>

<h1 align="center">Mako</h1>

<p align="center">
  <strong>One fast, local-first desktop for every coding agent on your Mac.</strong><br />
  Claude Code, Codex, Cursor, Grok, and Devin stay provider-native—and finally work as peers.
</p>

<p align="center">
  <a href="https://github.com/kashyab12/mako/releases"><img src="https://img.shields.io/github/v/release/kashyab12/mako?display_name=tag&sort=semver" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20silicon-black" alt="Apple silicon" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-black" alt="MIT license" /></a>
  <a href="https://github.com/kashyab12/mako/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/kashyab12/mako/release.yml?label=release" alt="Release workflow" /></a>
</p>

<p align="center">
  <img src="docs/images/mako-hero.png" alt="Mako showing a live agent conversation, file workbench, and project sessions" width="1120" />
</p>

## Why Mako

Coding-agent work is fragmented across terminals and apps. The account is
already signed in. The model is already selected. The session is already on
your machine. Mako reads those provider-owned sessions in place and gives them
one calm control surface—without inserting another model between you and the
agent.

| | |
| --- | --- |
| **Every local session** | Discover and live-follow Claude Code, Codex, Cursor, Grok, and Devin sessions created in Mako, a terminal, Zed, or another compatible client. |
| **Native continuation** | Resume with the provider that owns a session, or move the conversation to another provider through a deterministic transcript bundle. |
| **A real workbench** | Keep the conversation visible while opening multiple files in preview or pinned tabs. Split files right or down without losing the live transcript. |
| **Review before trust** | Inspect diffs, stage files, annotate lines, draft commits and pull requests, and keep publishing as an explicit action. |
| **Local browser and computer use** | Run isolated browser and macOS automation locally. There is no cloud-browser mode. |
| **Slack when the Mac is asleep** | A durable relay queues Slack work, then hands it to the selected local harness when Mako reconnects. Bring your own Slack app and backend. |

## The workbench

<p align="center">
  <img src="docs/images/mako-workbench.png" alt="Mako workbench with conversation and split file tabs" width="1120" />
</p>

- Preview tabs replace each other while you browse; pin the files you intend to
  keep.
- Split file panes horizontally or vertically while the agent conversation
  remains mounted and live.
- Render source with syntax highlighting, Markdown as prose, images at native
  quality, PDFs in Chromium, and CSV/TSV as bounded tables.
- Re-read open files when an agent, formatter, editor, or terminal changes them.
- Open a file in detected Zed, Cursor, VS Code, Windsurf, Sublime Text, or Xcode.

## Provider-native by design

| Provider | Discover | Live follow | Native resume | Models and controls |
| --- | :---: | :---: | :---: | --- |
| Claude Code | ✓ | ✓ | ✓ | model, effort, permissions |
| Codex | ✓ | ✓ | ✓ | model, reasoning, service tier |
| Cursor | ✓ | ✓ | ✓ | model, effort, fast mode |
| Grok | ✓ | ✓ | ✓ | model and reasoning |
| Devin | ✓ | ✓ | ✓ | model, mode, Zed/ACP ownership |

Mako’s renderer never receives provider credentials. Provider-specific session
formats, processes, locks, and continuation commands stay behind provider
boundaries in the host and [`@mako/sessions`](packages/sessions).

## See what the agents are doing

Tool calls are compact by default, not dumped into chat. Completed work folds
into one work log with elapsed time, tool count, failures, and background-agent
count. Expand it to inspect subagent assignments, activity, transcripts, and
results. Internal protocol and compaction messages never masquerade as user
conversation.

## Accounts and truthful usage

<p align="center">
  <img src="docs/images/mako-usage.png" alt="Provider-native account limits and local usage chart" width="880" />
</p>

- Account identity comes from each provider’s native credentials.
- Rate-limit windows come from provider endpoints and retain their real
  duration—Mako does not relabel a weekly window as “5h.”
- Local history aggregates reported cost plus clearly labeled API-equivalent
  estimates for Claude Code, Codex, and Mako sessions.
- Pricing coverage and unpriced tokens stay visible. Estimates are not presented
  as billing or subscription charges.

## Integrations

<p align="center">
  <img src="docs/images/mako-integrations.png" alt="Mako integrations catalog" width="880" />
</p>

The catalog distinguishes what is connected, locally available, waiting for
permission, or not implemented. Provider marks are recognizable; status color
keeps its semantic meaning.

Slack can use either Vercel Connect or a Slack bot you own. See
**[Run your own Mako Slack bot](docs/self-hosted-slack.md)** for the app scopes,
durable Azure relay, environment variables, Keychain setup, and end-to-end
verification.

## Install

### Download the Mac app

Download the latest Apple-silicon DMG from
[GitHub Releases](https://github.com/kashyab12/mako/releases). Builds are ARM64
only.

Unsigned development releases may require one explicit approval in macOS
Privacy & Security. The release workflow supports Developer ID signing and
notarization when the repository secrets are configured.

### Run from source

Requirements: an Apple-silicon Mac, Node.js 24, Git, and at least one supported
agent CLI.

```bash
git clone https://github.com/kashyab12/mako.git
cd mako
npm install
npm run desktop
```

Mako auto-detects the agents, accounts, models, editors, and native session
stores already present on the Mac.

For UI work without starting an agent:

```bash
npm run dev
open 'http://127.0.0.1:5173/?mock'
```

## Keyboard-first

| Shortcut | Action |
| --- | --- |
| `⌘K` | Commands, models, sessions, and plugin actions |
| `⌘P` | Open a file by name |
| `⌘⇧F` | Search files and conversations |
| `⌘T` | New agent tab |
| `⌘1–9` | Jump between agent tabs |
| `⌘↑ / ⌘↓` | Previous or next conversation turn |
| `⌘/` | Show contextual keyboard help |
| `Esc` | Stop, dismiss, or return to the conversation |

## Architecture

```text
Provider stores and CLIs
  Claude Code · Codex · Cursor · Grok · Devin
                    │
                    ▼
      host process + @mako/sessions
  credentials · processes · git · native formats
                    │
          one redacted IPC contract
                    │
                    ▼
              React renderer
 transcript · workbench · review · settings · plugins
```

The streaming hot path sends only the in-flight message and coalesces updates to
one flush per frame. Session discovery uses bounded reads and persistent caches;
unchanged sessions cost a stat and zero transcript reads. Long lists are
virtualized, offscreen turns use `content-visibility`, and the syntax/diff engine
loads only when a file opens.

## Build and release

```bash
npm run lint
npm run typecheck:all
npm run package:mac
```

`npm run package:mac` produces ARM64 DMG and ZIP artifacts in `release/`.
Pushing a `v*` tag runs the GitHub release workflow, tests the repository,
builds the Apple-silicon app, writes SHA-256 checksums, uploads workflow
artifacts, and publishes the GitHub release. The same workflow can be run
manually without publishing a release.

## Security and privacy

- Provider credentials remain in provider config or macOS Keychain.
- Secrets are redacted before crossing IPC.
- Slack requests use timestamped HMAC verification or Vercel Connect’s verified
  connector path, plus an explicit user allowlist.
- Automation definitions are shareable, but every automation starts disabled on
  a new machine and enabled state is never committed.
- Browser and computer-use tools run locally and are attached only to sessions
  Mako launches.
- Crash reports stay on disk unless you copy one yourself.

## Contributing

Read [`AGENTS.md`](AGENTS.md) before changing architecture or UI. The key rules:
providers remain peers, internal implementation libraries never become public
provider concepts, and Oxlint anti-slop must stay at zero warnings and errors.

```bash
npm run typecheck:all
npm run lint
npm test --workspace @mako/sessions
npm run backend:test
```

Issues and focused pull requests are welcome.

## License

[MIT](LICENSE) © 2026 Mako contributors.
