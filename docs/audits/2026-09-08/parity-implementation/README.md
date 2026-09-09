# Parity implementation

## Native agent observations and conversation controls

Claude SDK task events and Codex app-server collaboration items now populate a provider-neutral Agents companion. The roster preserves native identity, activity, results, reported model and usage, and the originating provider binding. Ordinary shell/MCP background tasks are excluded. Missing usage is left absent.

Observations persist in the conversation journal. Disconnect, restart and provider transfer turn active observations into “Status unavailable”; they do not manufacture completion. Late Claude progress cannot revive a completed task. Nested Claude agent messages no longer become part of the parent's answer. The roster is capped at 256 observations, preferentially evicts settled entries, and displays an omission notice. The panel mounts 40 rows at a time.

Agent-only events use narrow batches and retain the renderer's transcript projection by identity. Agent results expand in place. The composer shows the agent count only when observations exist; delegation remains a distinct action. The delegation dialog focuses its task field, preserves the draft, and restores focus when closed. Completed action receipts stay in the actions popover.

Validation:

- `npm run typecheck`: each TypeScript project passes in a separate process with a 768 MB V8 heap cap and a 120-second timeout. The earlier 512 MB cap was insufficient; a heap cap is not a physical-footprint guarantee.
- `npm run test:native-agents`: provider lifecycle, bounded roster, nested-content isolation, journal persistence, restart, and narrow host batches.
- `npm run test:live-controls`: production components render expected states; agent-only batches preserve the transcript projection; draft persistence regressions pass.
- `npm run test:live-actions` and `npm run test:codex-protocol`: existing driver/control regressions pass.
- `npm run lint`: no ESLint errors, two existing isolated-virtualizer React Compiler warnings, and no Oxlint warnings/errors.
- Actual local host opened without mock mode; inspected a real saved Claude test conversation and the registered Agents companion. No prompt sent.
- The explicit `/scripts/live-workflow.html?mock` fixture uses production components. Browser checks covered narrow/wide layouts, expanding results, nested provider picker Escape behavior, dialog Escape/focus return, task autofocus, draft restoration, mode picker and conversation actions.

During the roughly five-minute browser check, sampled host RSS fell from 510 MB at startup to 354 MB; the Vite process fell from about 1 GB during startup to 73 MB. System memory free readings ranged from 36–39%. This is a short observation, not attribution of the earlier memory incident or a soak-test result. The temporary server and tabs were closed afterward.

Still unverified: real newly spawned provider-agent events end to end, packaged behavior, workflow grouping, per-agent controls, and native-history import outside a captured live conversation. This unit does not close the entire native-agent parity row or establish whole-product parity.

## Proposed plans

Codex plan deltas and final plan items, and Claude ExitPlanMode proposals, now produce one shared proposed-plan artifact. Revisions replace the stable artifact instead of duplicating it. Plans survive the journal and canonical/native transcript conversion, appear as compact expandable cards, and contribute to whole-answer copying. The execution checklist also updates when its tool details change.

Cards support copying, Markdown download, creating a workspace file, and preparing implementation or revision replies. Saving refuses overwrites, paths outside the workspace, stale workspace selection, and oversized content. Incomplete or truncated plans cannot prepare implementation replies.

Prepared replies preserve existing text and attach the exact selected plan version as a removable preview chip. Switching between the two prepared intents replaces the unchanged trailing instruction. The provider receives the complete plan context; the transcript displays it as a chip, and prompt reuse preserves it. Drafts and refused sends retain plan references. A late send result cannot clear or overwrite newer text or references.

Validation:

- `npm run test:proposed-plans`: SDK permission capture, revisions, canonical/native round trips, copy/export, capture limits, journal persistence, and real workspace save boundaries.
- `npm run test:codex-protocol`: streamed plan deltas and final replacements retain one artifact.
- `npm run test:live-controls`: production card rendering, preparation, intent switching, stale-conversation rejection, and preservation across pending/refused sends.
- `npm run typecheck` and separate typechecking of the new test scripts; `npm run test:web` covers the new host method and generated input contract.
- `npm run lint`: zero errors, the same two isolated-virtualizer ESLint warnings, and zero Oxlint warnings/errors.
- Explicit production-component fixture checked in the browser: short drafts, preservation of existing text, plan preview/removal, intent switching, narrow layout, and save dialog focus. No provider prompt was sent.

Still unverified: a newly generated plan through each actual provider, packaged export/download behavior, and a full browser send/reload/reuse cycle. These checks establish the local implementation, not equal quality or latency against T3.


## Prompt delivery and queue

Idle sends now enter the conversation before awaited provider settings or host acceptance. A stable request ID joins the optimistic prompt to its host acknowledgement. Startup remains visible as “Starting…” or “Sending…”; only follow-ups waiting behind a turn appear in the queue. A refused submission removes its own pending projection.

Follow-ups share one compact “Up next” card above the composer. The card previews two messages, expands with bounded pagination, and supports editing and removal for live and native requests. Editing pauses the queued request durably so completion of the current turn cannot dispatch half-edited text. Save or Cancel releases that hold. The host checks request status and expected text before changing it; removed messages do not become failure cards. Edit drafts persist separately from the main composer. Escape restores focus to the edit button.

The reference comparison used Monocode (`568f246c`), OpenCode (`101ff6d1`), and T3 Code (`cd096b9a`), read only under `ignore/`. Monocode informed the compact editable queue beside the composer; OpenCode and T3 informed optimistic insertion before asynchronous submission work.

An additional delay came from refreshing provider discovery after a 30-second metadata TTL. Warm sends now reuse an available profile for the same provider/account/workspace; ordinary discovery and explicit refresh retain their refresh behavior. This removes unnecessary discovery from that path; it does not establish a provider first-token latency bound.

Validation:

- `npm run test:message-queue`: live/native pause across turn completion, one dispatch after edit, stale edits, removal races, journal rollback, durable hold/removal, original submission retry identity, and warm discovery/account/workspace isolation.
- Its production renderer test invokes the real send action with discovery deliberately unresolved: the prompt appears before the await and retains its identity after acknowledgement, with no duplicate bubble.
- `npm run test:live` and `npm run test:web`: conversation and generated IPC contract regressions passed.
- `npm run typecheck`, separate typechecking of the new test scripts, and `npm run lint`: zero errors; Oxlint zero warnings/errors; two existing React Compiler warnings on isolated virtualizers.
- Explicit production-component fixture checked in the browser: idle startup, compact and expanded follow-ups, narrow layout, edit/save, Escape/focus return, and removal. No actual provider prompt was sent during these checks.

Still unverified: packaged behavior, actual provider startup timing, and reload before the host has accepted an optimistic send. These changes do not claim complete product parity.

## Checkpoint reachability

A real Git garbage-collection regression exposed that blobs present only in the saved index could become unreachable. Each new checkpoint now retains that index tree as a parent commit of the working-tree checkpoint. Restore validates staged blobs before modifying workspace files, including for older checkpoints that lack that parent.

`npm run test:workspace-snapshots` reproduced the failure with `git gc --prune=now` in an isolated temporary repository, then verified staged-only content survives collection. A separate legacy-checkpoint case confirms missing blobs cause restore to refuse before changing the workspace or index. No collection was run against the user repository. Automatic checkpoint retention remains unimplemented.

## Interrupted sends

The composer saves a recovery copy before clearing text or detaching attachments. A new renderer presents unresolved copies for explicit restoration or dismissal; it never sends them automatically. Restoring appends to an existing paragraph. Successful host acceptance removes the copy, while a refused send returns it to the draft. If recovery storage cannot be written, the composer remains intact.

`npm run test:message-queue` now also starts a fresh process to verify recovery persistence, retained staged attachment paths, absence of automatic replay, accepted-receipt cleanup, and storage-quota refusal. The production-component browser fixture verified restoring beside a newer paragraph and returning focus to the composer.

## Exact Claude forks and host-owned native identity

Claude now supplies its account-scoped transcript path through SDK lifecycle hooks. The host also links provider-native catalog discoveries to live conversations without requiring a renderer to open them. This fixes a restart gap where an unopened conversation retained its visible transcript but lacked the native path needed for safe resume.

Completed Claude turns retain a separate fork boundary. A bounded native-tail reader follows the observed main-thread message through tool carriers and trailing attachments, and requires the persisted leaf marker to agree. The reader briefly waits for the native writer because the SDK result can precede its file flush. Steering into an already-ended turn is refused during that interval. Missing or ambiguous evidence leaves portable forking available. Native forks use the SDK's `resume`, `forkSession`, and `resumeSessionAt` options. Empty context packages are no longer sent as reading instructions when native history already covers the selected point.

A real SDK test kept a selected value, excluded a later replacement, allocated a different native session, and recalled the selected value without portable history. The closed source transcript's fingerprint stayed unchanged. Evidence: [claude-native-fork.json](./claude-native-fork.json). Rerun with `npm run build:electron && node scripts/test-provider-e2e.mjs claude --fork-only`.

`npm run test:live-actions` covers native-path discovery without renderer binding, idempotent discovery, delayed native writes, stale boundary removal, carrier/attachment retention, bounded tails, torn writes, and ambiguous chains. Conversation transfer, native request, native continuation, native history and relay-conversation regressions also pass.

## Package verification work

A packaged restart test exposed the missing host-side native binding described above. A separate packaging attempt caught a build-output race: compiling while the packager collected files produced imports without their corresponding files. Packaging now freezes compiled inputs, checks that the copy matches the source, packages from that copy, and compares the resulting archive bytes against the frozen inputs. A TypeScript-parser-based check also verifies relative imports in the packaged host before launch. The rerunnable lifecycle test uses an isolated profile and a disposable workspace.

Final packaged restart, draft-reload and memory-soak results are pending below; source checks alone do not establish them.
