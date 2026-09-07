# Mako parity assessment and browser/computer investigation

The [follow-up browser permission audit](browser-permission-subsystem-audit.md) found unresolved connection churn and reproduced dependency-level stale-tab retry and implicit tab selection. The successful workflows below remain valid evidence for those runs, but do not establish a general no-replay or exact-target guarantee. Read that audit before relying on this comparison's browser conclusions.

September 7, 2026. The core conversation workflows, browser client isolation/recovery, and desktop form operations now have live evidence. Overall superiority to Codex or Orchestrator v2 is not established. The earlier desktop failure finding was caused by an incorrect test selector and is withdrawn below.

## Orchestrator v2

The GitHub API still reports PR #2829 open at `415ed0f73b97f1655b6282492f81d0b2bba3a9cc`, the revision covered by our [source investigation](../2026-09-06/orchestrator-v2-deep-dive.md). This comparison uses that pinned implementation and its indexed tests, not an upstream execution benchmark. The local reference checkout is on another commit; it was not modified or mistaken for the PR.

| Area | Mako today | Assessment against the reviewed v2 |
| --- | --- | --- |
| Conversation identity across provider switches | Durable conversation UUID, multiple native bindings, missing-context delivery, safe full-context fallback | Core behavior covered; real Claude → Codex → Claude run passed |
| Acceptance, queues, recovery | Durable receipts, request ownership, inactive-event rejection, conservative uncertain recovery | Core behavior covered by deterministic regressions; no comparative fault-rate measurement |
| Cross-provider delegation | Scoped MCP, isolated child workspace, durable delivery | Real Codex → Claude delegation and parent result retrieval passed |
| Lazy forks and merge-back | Portable forks; exact older-turn native Codex fork; context merge-back | Core portable behavior covered. Native Claude fork optimization remains a gap; v2 has additional provider-native paths |
| Dormant resume | Whole-file fingerprint plus authoritative inactive-process observation, otherwise captured context | Real same-native-ID Codex restart passed; this is an observation, not an external-writer lock |
| Files and images | Retained input files, tool sidecars, paged native capture, authenticated remote artifact transport | Real cross-provider image and large-file tests passed. We have specific evidence, not proof of universal superiority |
| Coordinated rewind | No operation that atomically restores filesystem, provider position, and app execution history | Behind v2's checkpoint/rollback model |
| Provider controls | Live driver contract exposes resume/native fork plus prompt, cancel, permission and mode operations | Behind v2's richer contract for steering, rollback/snapshots, injection, and identity strength |
| Unified execution graph | Durable Mako requests, bindings, transfers and children | Do not equate this with v2's full normalization of provider-native subagents and background tasks |

[Paid runs, commands and limitations](conversation-control.md) remain the evidence for Mako's completed conversation work. Six providers passed actual file-tool/model round trips. Neither those runs nor T3's source tests supply a matched performance or reliability comparison.

## What the browser/computer paths actually are

Mako exposes three managed integrations through `electron/mcp-registry.ts`:

- `mako-browser-use` runs bounded Python through the installed Browser Use CLI, with private control state and a separate daemon for each MCP connection.
- `mako-local-control` exposes the CUA driver's MCP tools through a private, host-started embedded socket.
- `mako-local-tools` wraps macOS Harness for app state, screenshots, clicks, typing, scripts, and general execution.

That is substantial underlying functionality. It is not yet one coherent application-owned target/session/approval model.

The installed CUA driver is 0.19.3. A real connection through Mako's `ensureCuaEmbedded` and the SDK stdio client negotiated 54 tools. Read-only permission status reported host accessibility and screen recording grants. Its schemas cover exact window/browser targeting, semantic DOM snapshots, snapshot tokens, uploads/downloads, dialogs, scrolling/dragging, background input, and deterministic state predicates. These are driver capabilities, not newly implemented Mako features.

The test host was Node launched by Codex. This does not certify the signed Mako release's OS permission attribution. The driver correctly reports embedded host attribution; the host bundle label alone is not permission evidence.

## Concrete findings

### Fixed: browser mutation replay after an uncertain result

`electron/browser-tools-main.ts` used to catch errors matching `timed out`, `connection refused`, or `daemon`, run `browser-use --reload`, and execute the original source again. An action can complete before its response fails. Replaying it can submit a form twice, and reloading the shared daemon can disrupt other tasks.

The regression uses the real MCP server and SDK client with a fixture CLI. The fixture records execution, then returns an error saying its action completed but the daemon connection timed out. Before the fix, one call produced three process invocations: action, reload, action. After the fix, it produces one. The error reaches the caller without automatic replay.

`npm run test:mcp` includes this regression in `scripts/test-browser-tools.ts`.

### Fixed and verified: independent browser clients

The installed Browser Use 0.1.8 daemon has one mutable `self.session` / `self.target_id`. A real two-client test showed that client A read client B's page after B navigated. This was an application integration defect, not merely a theoretical race.

`electron/browser-tools-runtime.ts` now gives each MCP connection a private runtime/configuration directory and local control daemon. Calls on one connection serialize. New connections start on a fresh blank tab; agents select existing tabs explicitly. Cloud-autospawn and endpoint overrides are removed from the child environment. This isolates control state while continuing to use local Chrome; it does not create separate browser profiles or sandbox arbitrary Python.

The same two-client test now passes. It also enters a random value using browser input events, clicks the button, and verifies exactly one submission to the correct local endpoint. `mako_browser_screenshot` returns a native MCP PNG image block; its actual image shows fixture A, as expected.

The runtime records daemon PID and PID-file generation. A real daemon restart causes the next execution to refuse before running the supplied source. Client B remains on its original page. `mako_browser_reconnect` explicitly resets only A's binding, and its next execution starts on a new blank tab. Interrupted commands are never automatically replayed.

A deterministic process test verifies that canceled queued work never starts, subsequent work proceeds, private directories differ between clients, inherited remote settings are absent, and graceful cleanup targets only each connection's daemon. Stdio EOF, SIGTERM and SIGINT initiate cleanup. An uncatchable process kill is not covered by the graceful-cleanup guarantee.

Chrome initially reported a remote-debugging approval requirement. After inspecting Chrome with computer use and retrying, the live connection and all browser tests succeeded. No approval remains pending for the successful runs.

### Corrected and verified: desktop control

The initial test used `/text(field)?/` to select the Proof input. That also matched its `AXStaticText` label. The test sent typing to the label, then incorrectly attributed the resulting zero-character delivery to a product failure. The earlier claim that this established a Codex advantage was invalid.

The corrected test selects the exact `AXTextField` role and its observed token. Mako's embedded CUA path now passes screenshot capture, background field entry, button activation, independent renderer readback, and stale-token refusal. Its explicit `set_value` route also passed a separate run. Codex's computer-use API passed the same form earlier. These are functional checks, not a statistical performance comparison.

`scripts/test-local-control-e2e.mjs` launches only its disposable Electron form, uses its actual PID and exact window title, and saves tool responses and a fixture screenshot. The fixture writes its independent state atomically so polling cannot misinterpret a partially written JSON file.

### Fixed and verified: provider MCP startup through symlinks

The first real-model browser run could not discover the browser tools. A direct stdio probe reproduced the cause: the entry-point check compared a symlink spelling in argv with the resolved module path and silently skipped MCP initialization.

`electron/main-module.ts` compares canonical paths. Both browser and local-app MCP entry points use it. `scripts/test-mcp-entry.ts` launches both through symlinks and verifies their actual tool listings.

Paid Codex and Claude runs through Mako then discovered and used the browser tools, requested screenshots, read a random page value, counted four red and two blue squares, entered three fields with trusted browser input events, submitted exactly once with a real click, verified success, and closed its created tab. The server independently validated the value, counts, trusted input and click flags. Both models passed the same independent server checks. The fixture lives in `scripts/provider-e2e-browser.mjs` and is selected with `--browser` in the paid runner.

### Remaining integration gaps

Mako still has three GUI integrations rather than one application-owned app/site permission model. The separate macOS Harness screenshot wrapper returns path/metadata text; the CUA and new browser screenshot paths return images. An isolated child worktree does not isolate browser cookies or desktop applications. Raw Python remains a trusted execution capability, not a security sandbox.

Mako also does not have the comparable built-in browser preview/annotation product or coordinated filesystem/provider rewind described below. The successful GUI tests do not establish those missing capabilities.

## Codex baseline

Current official documentation redirects the older Codex feature URLs to ChatGPT desktop documentation, explicitly covering Codex use. The [browser documentation](https://learn.chatgpt.com/docs/browser) describes a separate built-in profile, shared preview, page annotations, existing-browser extension access, and site controls. The [computer-use documentation](https://learn.chatgpt.com/docs/computer-use) describes per-app access controls, macOS background use, Windows foreground use, and optional locked-Mac operation. Mako does not currently match that integrated product scope.

The installed browser plugin's `tab-claiming-chrome.md` additionally requires matching browser instance, tab ID, URL and title before claiming an existing tab. This is a useful target-identity contract to adopt. Its presence is implementation guidance; it is not a matched adversarial test of either product.

## What would justify a better-than-Codex claim

1. Keep real renderer/application readback as the pass condition, and expand the passing desktop checks to representative native, Electron and browser workflows.
2. Extend the proven browser connection isolation into a unified GUI target and permission model. Expand coverage for user-driven tab changes, multiple browser profiles, stale targets and abrupt host termination.
3. Consolidate visual output and readiness across all GUI integrations. Preserve native image delivery and structured refusals through each provider path.
4. Run the same fixtures with the same model and task budget through both products. Include forms, dynamic rerenders, dialogs, uploads/downloads, multiple windows, native and Electron apps, foreground contention, restart, and prompt-injection attempts. Measure successful final state, unintended actions, time, tool calls, token cost and required human interventions.

A reasonable initial gate is at least 30 paired attempts per representative workflow, zero wrong-target or duplicate consequential actions, and a measured success/latency advantage without weaker access controls. This is a proposed acceptance gate, not a result already achieved.

[Machine-readable probe and comparison evidence](computer-control-evidence.json) records the observed outcomes, tool responses, and original evidence directories.

## Reproduce

```sh
npm run test:mcp
npm run test:local-control-e2e
npm run test:browser-use-e2e
node scripts/test-provider-e2e.mjs codex claude --browser
```

The GUI commands open and control disposable fixtures. The provider command performs paid model requests. The direct browser suite exercises live Chrome, screenshots, independent clients, trusted input/click submission, real daemon restart and explicit reconnect. The desktop suite exercises the installed CUA driver and independent renderer readback. Each prints its evidence directory.

Focused MCP regressions, Electron build and lint passed during implementation. See [final verification output](gui-verification.txt). Oxlint has zero warnings/errors; ESLint retains two existing TanStack Virtual / React Compiler warnings.
