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

`npm run test:workspace-snapshots` reproduced the failure with `git gc --prune=now` in an isolated temporary repository, then verified staged-only content survives collection. A separate legacy-checkpoint case confirms missing blobs cause restore to refuse before changing the workspace or index. No collection was run against the user repository. Age/count retention and a private checkpoint-payload byte budget were subsequently implemented as described below.

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

## Checkpoint retention and startup validation, September 9

Checkpoint cleanup now targets 30 days and 1,000 records per profile/workspace, removing at most 64 per pass. Active run baselines, persisted 30-minute preview leases, and unfinished restore inputs/backups take precedence over those limits. Cleanup verifies ownership and uses a compare-and-swap Git transaction before deleting saved indexes and metadata. It never runs Git GC. Completed restore receipts still work after the target checkpoint expires.

`npm run test:workspace-snapshots` passes count/age limits, active-run protection, preview persistence, actual restore-process death, cleanup interruption/retry, changed and symbolic refs, legacy checkpoints, profile isolation, and bounded cleanup batches. These checks run only in disposable repositories. At this stage, Git object reclamation, completed-receipt growth, a physical byte quota, and matched large-repository latency were still open; the follow-up below records the subsequent storage changes and verification.

Repeated packaged testing exposed a startup draft race: input could be saved under `project:/` before workspace metadata arrived, then disappear from the composer when its target changed. The composer now stays inert and read-only with an opening-workspace placeholder until a workspace or existing conversation supplies a draft target. The production-component UI regression verifies this boundary with trusted input and retains a startup screenshot.

The rebuilt isolated package at `/tmp/mako-retention-package-23403-boot/mac-arm64/Mako.app` passed archive-byte verification for 859 files, 383 relative host imports, ad-hoc signature verification, and launch. Two renderer-only runs each preserved a draft through three reloads. Reports are retained in `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-FVVnvC/result.json` and `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-duF3Vg/result.json`. Rerun with `npm run test:packaged-lifecycle -- /path/to/Mako.app --renderer-only`; it starts no provider.

The initial live Claude package test was blocked by an expired OAuth session that could not refresh. The initial broader workspace UI run passed the startup regression but failed its offscreen-animation assertion, and repository lint caught a concurrent `no-runtime-typeof` violation. Those failures were retained rather than reported as passes. The follow-up below supersedes their pending status.

## Reliability follow-up

After authentication was restored, the current full UI suite and full lint passed. The UI run covers offscreen/reduced-motion behavior, startup input gating, attachment editing, single-send behavior, draft reload, and window isolation. Typechecking, host/web boundary tests, stage/identity tests, live controls, conversation transfers, queue/recovery tests, and snapshot tests also passed. ESLint retains the two known isolated-virtualizer warnings; Oxlint reports zero warnings and errors.

New snapshots now hold self-contained Git packs in private 0700 directories. Capture leaves the user's Git object database and refs unchanged. Restore imports the selected pack before publishing its saved index, so expiration cannot make staged blobs disappear. The default retained-payload budget is 1 GiB per workspace/profile, with 512 MiB per snapshot. Allocation-aware file measurements drive eviction and admission, rather than estimated source sizes. Protected recovery data takes precedence: a full budget refuses a new retained capture instead of deleting a baseline or unfinished restore.

A quota-full regression exposed unnecessary duplicate restore backups. Restore now reuses the persisted preview as its safety backup and uses bounded temporary current-state captures, including for compensation after a failed conversation commit. These temporary stores are cleaned up. Process-death tests verify abandoned captures are reclaimed; completed uncatalogued stores and live captures are preserved. The payload quota does not cover the SQLite catalog, provider-native history, or temporary working files. Legacy repository-backed objects are not garbage-collected automatically.

`npm run benchmark:snapshots` verifies capture, preview, restore, and staging on 100-file and 5,000-file fixtures. The latest retained payload measurements were 134,624 and 3,263,968 bytes. Timings varied under concurrent machine load; they are individual observations, not percentiles or matched T3 performance results. Full measurements: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-snapshot-benchmark-9UG6ju/results.json`.

The final isolated package is `/tmp/mako-reliability-verified-20260909/mac-arm64/Mako.app`. Its 865 compiled files were compared with frozen inputs and 396 relative host imports resolved. Ad-hoc signature verification, launch, real Claude completion, restart, same-native-session resume, and marker recall passed. Report: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-IkM1QT/result.json`. Cold acceptance was still slow in that run, about 53.6 seconds; this is not a startup-speed claim. A separate real Claude workflow passed two file-writing turns, checkpoint preview, file restore, and an idle conversation fork: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-rewind-e2e-t8SvyP/result.json`.

The approved non-privileged memory run passed 54 reloads over 611,146 ms with the draft intact. Median measured physical footprint declined from 2,081,073,304 to 1,878,781,184 bytes. Whole-tree RSS and measured physical footprint stayed within their 4 GiB test limits, and the system-memory-free floor held. macOS denies physical reads for setuid-root `ps`; those readings remain explicitly unavailable, not successful zeroes. Report: `/var/folders/hp/kb3x97w90sv7967ldlym822w0000gn/T/mako-packaged-lifecycle-VDwTrJ/result.json`. This verifies the recorded ten-minute workload and coverage, not a multi-hour or all-workload stability guarantee.
