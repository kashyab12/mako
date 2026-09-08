# @mako/sessions

Pure native-session storage, translation, and settings contracts for coding-agent hosts. Electron and React are not dependencies.

## Settings

Import `@mako/sessions/settings` in a renderer, CLI, or host. `SessionSettings` holds a model identity and typed option values. Absence means inherit or unobserved; it never means false, medium reasoning, or the first model in a catalog.

Keep three inputs separate:

- `SessionModel[]` describes supported choices, aliases, variants, and applicable defaults.
- Provider configuration and session observations are `SessionSettings` snapshots.
- `SettingsPreference` records saved or legacy user preferences. Pending edits are a separate snapshot owned by the caller's draft or thread.

`resolveSessionSettings` returns each value with its source, the resolved settings, and applicability issues. Existing sessions use pending edits followed by session observations. New drafts use pending edits, saved preferences, then provider configuration. Catalog defaults apply only to an explicit model selection, where applicable. Options from a different model do not carry across a model change. Unknown values remain unknown.

```ts
const selection = resolveSessionSettings({
  models,
  context: "existing",
  phase: "turn",
  session: observed,
  overrides: pending,
})
```

Use `selection.model` and `selection.options` for presentation. Reject `selection.issues` before dispatch, then pass `selection.settings` through `resolveModelLaunch` to obtain the provider's launch ID. Option aliases and encoded model variants normalize in the shared resolver. An unavailable combination throws instead of choosing a different variant.

`@mako/sessions/model-catalog` supplies pure provider catalog normalizers. Configuration I/O, account selection, live protocol controls, and provider wire serialization remain host responsibilities. Hosts should refresh catalogs per workspace/account and merge reported live capabilities before calling the resolver.

Store the resolved settings on each queued request. A later composer edit must not alter a previously accepted request. Reconcile acknowledgements only when they match pending edits; a response to an older request must not erase a newer selection.

Native `ThreadRef.settings` holds the latest bounded observation. An empty snapshot explicitly means the native store did not establish current settings, even when historical `model` metadata exists.

## Verification

Run `npm test --workspace @mako/sessions` from the repository root. Desktop integration regressions run with `npm run test:tuning` and `npm run test:live`.
