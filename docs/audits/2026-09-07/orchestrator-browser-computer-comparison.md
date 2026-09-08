# Mako provider, browser and computer assessment

Updated September 7, 2026 after the control rebuild and the all-provider UI investigation. Mako now owns its browser connection and exposes exact task bindings through MCP. The removed Python daemon is described only in the [historical permission audit](browser-permission-subsystem-audit.md).

The work establishes specific functioning workflows and fault behavior. It does not establish that Mako is better than Codex overall, that all providers expose identical native controls, or that every possible UI interaction has been tested.

## All six providers

Every registered live driver passed the shared lifecycle checks for open, running, completed, closed while awaiting permission, and later external activity. An open process, a recently changed transcript, and a running turn are separate states. Only explicit running or permission evidence puts a session in Running now.

| Provider | Live work started in Mako | External activity evidence | Store and model evidence |
|---|---|---|---|
| Claude Code | ACP lifecycle and permission events | Registry state plus live process identity; idle/unknown is Open. Failed process verification is unavailable. | Native translation/follow tests; real file-tool/model round trip passed |
| Codex | App-server lifecycle and permission events | Open rollout plus bounded task-start/completion parsing. Completion clears Active even when the file stays open. | Gigabyte rollout, resumed-path selection, native restart/fork, translation/follow, real model tests passed |
| Cursor | ACP lifecycle and permission events | An open native database establishes Open, not a running turn. | Native database/WAL and follow tests; real file-tool/model round trip passed |
| Grok | ACP lifecycle and permission events | Registry plus verified process identity establishes Open. Failed identity reads are unavailable. | Streaming/follow tests; real file-tool/model round trip passed |
| Devin | ACP lifecycle and permission events | A session lock establishes Open. It is not sufficient running-turn evidence. | Streamed rows, tools, reasoning, locks and follow tests; real file-tool/model round trip passed |
| OpenCode | ACP lifecycle and permission events | External running-turn detection is not implemented. Persisted pending rows and recent timestamps no longer claim Active. | V1/V2 stores, tools, interruption, compaction and follow tests; real file-tool/model round trip passed |

The paid six-provider evidence is in [paid-provider-evidence.json](paid-provider-evidence.json). It is separate from the new shared lifecycle fixtures. Browser model workflows were exercised with Claude and Codex, not all six models. No general all-provider browser-vision claim follows from the six file-tool tests.

Additional fixes from the live UI investigation:

- Codex discovery resolves resumed rollout aliases through the provider's canonical SQLite path and physical file metadata. Historical explicit paths remain readable.
- Loading and failed thread opens retain the exact provider and draft owner. Superseded responses cannot replace a later selection. A successful retry follows once; a missing cached page becomes a readable failure instead of permanent loading.
- Host loss shows a persistent notice and Last known activity. Sending is disabled before drafts or attachments are cleared. The workbench remains mounted.
- Terminal loading exposed shared Vite cache corruption: the gateway regression server invalidated the running desk's optimized xterm files, returning HTTP 504. Development servers and tests now own separate caches. A new regression checks the four exact dependency URLs before and after the gateway test. Panel error boundaries also keep a failed companion from unmounting the conversation. The real terminal then loaded and printed `MAKO_TERMINAL_CACHE_OK` through actual keyboard input.
- Settings switches require accessible labels in the shared component. File browsing distinguishes loading, empty results, and failed reads with Retry.

## Current control architecture

`BrowserService` owns one WebSocket per discovered browser installation. Multiple MCP clients join the same pending connection and use the same connected transport. Closing a client does not close Chrome. Browser restart or host shutdown invalidates the generation. Each target handle carries browser, tab, generation, and a lease; ownership is tied to the Mako conversation and checked at dispatch.

Browser tools never pick a replacement tab or replay a failed action. A timed-out or cancelled dispatched mutation can have an unknown result. That binding refuses more mutations until observation. Takeover is explicit and cannot steal an active operation. The service uses page focus emulation for background input and disables it on release.

The MCP contract supplies typed tools and server instructions for discovery, connection, target ownership, navigation, accessibility observation, screenshots, input, file uploads, events, JavaScript, and raw CDP. `mako_browser_help` exposes the installed protocol schemas. The CDP route supports network inspection/interception, emulation, keyboard and pointer input, frames, workers, dialogs and download configuration. Raw target lifecycle mutations are constrained so ownership stays with Mako. `concurrent:true` lets a caller answer a paused network request or dialog while another command waits.

`mako_browser_exec` runs asynchronous JavaScript in a terminable worker, with persistent per-client state, text output and native image output. Awaited operations use the same host service. Run identity prevents late messages from leaking into another script; unawaited work and CPU-bound cancellation are tested. This is trusted local JavaScript with operating-system power, not a sandbox.

The computer MCP forwards the native CUA driver's schemas, annotations, image blocks and structured coordinate metadata. Mako injects the task session identity so the caller cannot replace it. Failed initialization closes the failed transport; a later request creates a fresh SDK client. Mutating calls are not replayed. Native driver capabilities include window/app discovery, accessibility and pixel targeting, keyboard, pointer, scroll/drag, menus, clipboard, dialogs and window operations. Mako uses its embedded driver socket. The legacy macOS wrapper remains an availability fallback, not a second browser transport.

Chrome connection approval, macOS Accessibility/Screen Recording, and provider tool approval are separate. The transport persists while the host and browser remain connected; it cannot promise permanent Chrome approval across restarts. Discovery currently identifies installations and their configured endpoint, not a user-selectable catalog of every browser profile.

## Verification after the rebuild

| Check | Result and limit |
|---|---|
| Browser service fault suite | Ten task clients share one connection; serialized claims, stale leases, restart generations, closed targets, cancellation uncertainty and binding authorization pass with a protocol fixture |
| Script runtime | Persistent state, native images, CPU cancellation, cancelled queued work, late/unawaited work and recovery pass |
| Real Chrome | Two exact targets, real images and coordinates, trusted input, one independently recorded submission, replacement-client binding recovery and closed-target refusal pass |
| Real Mako through its own browser MCP | Opens the actual web desk and selects the active audit conversation using observed controls |
| Real model browser workflow | Claude and Codex each read a random page value, inspect four red/two blue squares, fill three fields with trusted input and submit once. Server readback validates values and trusted event flags. The prompt names the tool family, so this is not a tool-discovery benchmark from an uncoached user prompt |
| Computer proxy fault suite | First backend initialization fails; second succeeds on the same outer MCP connection. Native schema, task identity, annotations, images and metadata pass |
| Real computer control | Disposable Electron window, exact PID/window/token, screenshot, field entry, button activation, independent renderer readback and stale-token rejection pass |
| Real UI | Agents, MCP, Skills, Integrations, Editor, Conversation, Appearance, Keyboard shortcuts, Commit messages, Automations, UI extensions, Updates, Crash reports and About inspected. File filter and actual conversation selection exercised. Long palette queries, dismissal, the terminal dock and real terminal input/output were also checked. Account/configuration writes were not needed |
| Repository checks | Session package, live/conversation control, provider, stage/thread-opening, host, web, MCP, typecheck and production build pass. Oxlint reports zero warnings/errors. ESLint retains two existing TanStack Virtual compiler warnings; no rules were disabled |

Latest real browser evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-browser-e2e-gAQhgf`.

Latest real computer evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-control-e2e-f3JCJZ`.

Rebuilt paid browser evidence: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-provider-e2e-kC1tY6`.

The computer fixture used the development host and installed CUA driver. It does not certify OS permission attribution for a separately signed or packaged release. The desktop and web app share renderer and host contracts; the real web/preload tests verify both boundaries, but this is not a full packaged-release test.

The live cache regression can be rerun while the web desk is running:

```sh
node scripts/test-web-cache.mjs http://127.0.0.1:5174/
```

The normal web test owns its temporary cache and does not depend on a running desk. The manual browser observation also reproduced the cached import error inside the terminal boundary while the composer and rail remained mounted.

## Comparison with the available Codex tools

The installed browser API was inspected, including Playwright locators, frame locators, file chooser support, clipboard, dialogs, event waits, console logs and browser capabilities. This is an API comparison, not a matched reliability benchmark.

| Capability | Mako | Available Codex browser/computer tools |
|---|---|---|
| Existing browser control | Persistent direct CDP with exact owned targets | Browser extension or built-in browser; explicit tab claiming |
| Flexible browser programming | Persistent JavaScript plus documented raw CDP | Persistent JavaScript orchestration with Playwright, browser CUA and optional CDP |
| Common browser actions | Typed click/type/upload; other actions through CDP and protocol help | Rich locator fill/press/check/select, waits, frame locators and CUA helpers |
| Screenshots | Native images with target identity and coordinate metadata | Native screenshot/image output |
| Native applications | Full installed CUA MCP tools and task session injection | Native app/desktop CUA API and persistent orchestration |
| Integrated browsing product | No separate managed browsing profile, page annotation UI or content-export product | Built-in profile/preview, page annotations, content exports and site controls |
| Permission product | Chrome connection state plus OS permissions; trusted local execution | App and site controls integrated into the desktop product |

The [official browser documentation](https://learn.chatgpt.com/docs/browser) describes preview, annotations, existing-browser access and site controls. The [official computer-use documentation](https://learn.chatgpt.com/docs/computer-use) describes platform-specific app controls. Mako does not match that entire product scope. Raw CDP gives broad control, but it is not equivalent to already having all the higher-level helpers or integrated UX.

Remaining work is concrete: richer ergonomic browser helpers, a persistent native-computer scripting API, multiple-profile selection, packaged-release permission tests, broader native app coverage and same-model/same-budget comparative workflows. An already open historical rollout also does not automatically switch to a new canonical path while preserving every draft and attachment; reopening uses current discovery. These limits should remain explicit.

## Orchestrator v2

The comparison remains pinned to PR #2829 revision `415ed0f73b97f1655b6282492f81d0b2bba3a9cc`, covered by the [source investigation](../2026-09-06/orchestrator-v2-deep-dive.md). Its current merge status was not rechecked in this pass.

Mako has durable conversation identity, provider switches, receipts, scoped child delegation, portable context and attachment transfer, and tested native Codex restart/fork paths. Those are covered in [conversation-control.md](conversation-control.md). Coordinated filesystem/provider/history rewind, richer native steering/snapshot controls, and a fully normalized graph of provider-native background work remain differences from the reviewed v2. The rebuilt browser transport does not establish parity in those areas.
