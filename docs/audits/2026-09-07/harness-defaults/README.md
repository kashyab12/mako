# Harness defaults and composer settings audit

Investigated the local source on 2026-09-07. This is an investigation, with executable reproductions, not a runtime fix. Reference repositories were read without modifications. No provider prompt was sent and no user config was changed. The reference called “omniagent” in the request is present locally as `ignore/omnigent`.

## Main finding

Mako mixes catalog capabilities, provider configuration, saved composer preferences, historical thread metadata, and active session settings. There is no single resolved selection consumed by both the composer and the send path. Consequently the controls can describe settings different from those sent to the provider.

## Confirmed findings

1. **Codex configured defaults are never discovered.** `electron/providers/codex/profile.ts:40` calls only `model/list`. `normalizeCodexModels` in `electron/harness-models.ts:277` turns `isDefault` into the default model and `defaultReasoningEffort` into `current`. There is no `config/read`, workspace argument, or configured reasoning/speed field. A catalog default is not evidence of the effective workspace configuration. The profile loader contract accepts only an environment, so workspace-scoped defaults cannot be represented correctly by that API.

2. **Discovery becomes a permanent override.** `src/state/thread-tuning.ts:36` imports catalog `current` values into `composerTuning`, persists them, and marks the provider imported. Subsequent external changes are deliberately ignored. Even a partial existing override prevents importing other defaults. `scripts/test-tuning-import.ts` explicitly tests this freeze. Fresh discovery alone therefore cannot repair existing saved values. There is no provenance to distinguish an automatically imported value from an intentional user choice.

3. **Display and dispatch use different precedence.** `src/components/composer/foreign-model.tsx:45` prefers the historical thread model. `foreign-effort.tsx:37` uses that model's options with provider-wide saved tuning, or a historical variant's values. `src/state/acp.ts` and `src/state/thread-continuation.ts:104` dispatch provider-wide `composerTuning`. Opening thread A while the saved choice is model B can show A while sending B. `composer-routing.tsx:29` temporarily suppresses the historical label after an explicit model click, but stores that exception in component state for only one context. It is not a durable thread selection. For variant models, historical variant values also take precedence over option edits.

4. **Confirmed runtime settings are discarded.** `electron/codex-app-parse.ts:269` parses the open-thread response's model, service tier, and reasoning effort. `electron/codex-app.ts:174` uses the thread ID, cwd, and history but never publishes those resolved settings. Codex live state starts with empty config options. ACP does publish config options, but the composer option controls read provider profiles rather than those live config options.

5. **Speed is represented inconsistently.** Codex normalization accepts `serviceTiers` but ignores `additionalSpeedTiers`. A catalog containing only the latter yields no speed control. Codex's service tier is a select, so `foreign-effort.tsx:52` excludes it from the visible Fast button and places it in the options popover. The importer's speed-name heuristic converts a string tier such as `fast` into `fast: false`, while retaining `options.serviceTier: 'fast'`. App-server serialization honors the string option first; its boolean fallback sends `fast` only for true and omits false. The native Codex runner ignores the boolean entirely despite advertising fast support. Explicit standard, inherit, and unknown need distinct representations and provider-owned wire mappings.

6. **Other providers also substitute guesses for defaults.** Claude normalization sets supported Fast mode to false without reading its configured state. Devin honors the default variant only enough to identify its family; launch ID and option currents still come from the first variant. OpenCode marks `medium` as a default variant and prefers a named free model or the first model when configured discovery fails. Cursor reads its configured model, but removes bracket suffixes and deduplicates by the base ID, which can erase distinctions if those suffixes encode selectable options. These findings follow the code; they are not claims about every installed provider's current catalog.

7. **Reloading the profile cache loses default metadata.** `electron/provider-profile-cache.ts:11` validates option values with only `value` and `label`. Zod strips `default` and `description` when reading the cache. Select options that rely on `values[].default` and have no `current` behave differently after restart.

## What the reference apps actually do

These comparisons concern the checked-out snapshots, not claims that their entire implementations are correct.

| App and revision | Useful mechanism | Evidence and limits |
| --- | --- | --- |
| T3 Code `cd096b9a` | Resolves descriptors once, then derives both displayed effort and dispatched option selections. Draft selections are scoped by provider instance. | `ignore/t3code/apps/web/src/components/chat/composerProviderState.tsx:58`, `apps/web/src/composerDraftStore.ts`. `apps/server/src/codexModelOptions.ts` still maps boolean false to omission, so it is not proof of correct explicit speed reset. |
| Monocode `568f246` | Builds typed model settings from the runtime catalog; handles both `serviceTiers` and `additionalSpeedTiers`; adds a Standard option. | `ignore/monocode/src/lib/harness/codexCatalog.ts:169`. `codexProtocol.ts:73` omits the `default` tier from requests. Its Standard label therefore needs checking against inherited provider config before copying it. |
| Omnigent `3b653b92` | Tracks active thread model and reasoning, mirrors provider changes into session metadata, and distinguishes default effort from an unseeded observation. Filters effort levels using the current model. | `ignore/omnigent/omnigent/codex_native_forwarder.py:319` and `:2977`; `web/src/pages/ChatPage.tsx:4146`. No equivalent end-to-end fast-mode guarantee was established in this inspection. |
| ORCA `b6d5972e` | Explicit value provenance and unknown state. A shared resolver chooses the model for both rendering and applying settings. Unsupported live changes have disabled reasons. | `ignore/orca-stably/src/shared/native-chat-session-option-snapshot.ts:169` and `:203`. It only names a CLI default when catalog metadata explicitly proves that default, and avoids pretending unknown toggle state is off. |

ORCA's provenance and T3's shared display/dispatch resolution are the strongest patterns to adopt. Copying a polished picker alone would preserve Mako's underlying bugs.

## Proposed correction

Keep capability catalogs separate from resolved settings. Provider modules should report effective configuration in the actual workspace and account/executable context, plus provider-confirmed session settings. Each setting needs a value and source, including unknown. Speed should retain the provider's semantic choices instead of being inferred from an option label.

Resolve the next turn in state, once. Explicit edits for that thread/draft take precedence; otherwise an existing thread uses confirmed session settings. New drafts use intentional saved preferences, then effective provider configuration. Only use a catalog fallback when it is applicable and proven. The same resolved result supplies the picker and dispatch. Reconcile provider acknowledgements back into state. Preserve an unknown or inherited value until resolved instead of showing an invented model, medium effort, or Fast off.

In the UI, show the actual next-turn model, `High reasoning`, and `Fast` or `Standard` when known. Explain inherited defaults in the menu. When the provider has not confirmed a value, say `Provider default` or `Unknown` as appropriate. Keep pending changes scoped to the thread/draft and expose unsupported changes accurately.

Migration must preserve intentional user choices. Existing imported preferences have no provenance, so blindly deleting all tuning would lose real choices. Introduce source-aware settings, retain legacy values as unclassified overrides, and provide a deliberate reset-to-provider-defaults action. Correct cache schemas and invalidate incompatible old snapshots.

## Verification

Run `node --import tsx docs/audits/2026-09-07/harness-defaults/reproduce.mjs` from the repository root. It imports production functions and demonstrates four existing failures: missing speed metadata, identical native commands for Fast on/off, wrong Devin default variant, and cache metadata loss. It uses synthetic inputs and a disposable cache, with no provider credentials or live prompts. Its assertions intentionally describe broken behavior; convert them into desired-behavior regressions when implementing the fix.

`npm run test:tuning` and `npm run test:codex-protocol` passed during the audit. Neither proves that displayed defaults match effective provider settings. No live UI reproduction was performed. Follow-up implementation must exercise new drafts, thread switching, resume acknowledgements, model/effort/speed edits, inherited Fast reset, workspace overrides, and restart against the real host.

`npm run lint` reached the anti-slop check and failed in unrelated, already-present browser-extension work: `browser-extension/background.ts`, `browser-extension/router.ts`, and `electron/browser-native-host.ts`. ESLint also reported two existing virtualizer compatibility warnings. No runtime source was edited by this audit.
