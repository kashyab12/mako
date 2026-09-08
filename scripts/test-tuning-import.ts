import assert from "node:assert/strict"

const storage = new Map<string, string>()
globalThis.localStorage = {
  get length() {
    return storage.size
  },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => void storage.delete(key),
  setItem: (key, value) => void storage.set(key, value),
}

storage.set(
  "mako.prefs.v1",
  JSON.stringify({
    composerTuning: { codex: { model: "a", effort: "high", fast: true } },
    providerTuningImported: ["codex"],
  })
)
const { prefsStore } = await import("../src/state/prefs.ts")
const { providerStore, providerProfileKey } =
  await import("../src/state/providers.ts")
const { threadsStore } = await import("../src/state/thread-store.ts")
const {
  resolveComposerSettings,
  settingsForSend,
  chooseComposerModel,
  chooseComposerOption,
  resetComposerSettings,
  threadSettingsTarget,
  settingsTargetKey,
  acknowledgeComposerSettings,
} = await import("../src/state/composer-settings.ts")
const { normalizeCodexModels } = await import("@mako/sessions/model-catalog")
const { acpStore } = await import("../src/state/acp-state.ts")
const catalog = normalizeCodexModels({
  data: [
    {
      model: "a",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
      serviceTiers: [{ id: "fast", name: "Fast" }],
    },
    { model: "b", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ],
})
const profile = {
  id: "codex",
  label: "Codex",
  available: true,
  transport: "app-server" as const,
  capabilities: [],
  ...catalog,
  settings: { model: "b", options: { effort: "low" } },
}
providerStore.set({
  contexts: { [providerProfileKey("codex", "/workspace")]: profile },
})
const draft = { kind: "new" as const, harness: "codex", cwd: "/workspace" }
assert.equal(prefsStore.get().providerSettings.codex.source, "legacy")
const migrated = resolveComposerSettings(draft)
assert.equal(migrated.model.kind === "known" && migrated.model.value, "a")
assert.equal(migrated.settings.options?.serviceTier, "priority")
assert.equal(migrated.settings.options?.fast, undefined)
assert.deepEqual(await settingsForSend(draft), migrated.settings)

resetComposerSettings(draft)
assert.equal(resolveComposerSettings(draft).settings.model, "b")
const changed = {
  ...profile,
  settings: { model: "a", options: { effort: "medium" } },
}
providerStore.set({
  contexts: { [providerProfileKey("codex", "/workspace")]: changed },
})
assert.equal(resolveComposerSettings(draft).settings.model, "a")
assert.deepEqual(prefsStore.get().providerSettings, {})

const ref = {
  harness: "codex",
  nativeId: "one",
  path: "/one",
  cwd: "/workspace",
  model: "a",
  settings: { model: "a", options: { effort: "low", serviceTier: "priority" } },
}
const second = {
  ...ref,
  path: "/two",
  nativeId: "two",
  model: "b",
  settings: { model: "b" },
}
threadsStore.set({ threads: [ref, second] })
const target = threadSettingsTarget(ref)
chooseComposerModel(draft, "b")
assert.equal(resolveComposerSettings(target).settings.model, "a")
chooseComposerOption(target, "serviceTier", "default")
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "default"
)
assert.equal(resolveComposerSettings(target).settings.options?.effort, "low")
assert.equal(
  resolveComposerSettings(threadSettingsTarget(second)).settings.model,
  "b"
)
assert.deepEqual(
  await settingsForSend(target),
  resolveComposerSettings(target).settings
)

const { replaceAcpConversation } = await import("../src/state/acp-state.ts")
const observed = {
  kind: "live" as const,
  key: "live",
  draftKey: "/one",
  harness: "codex",
  cwd: "/workspace",
  threadPath: "/one",
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  permission: null,
  sending: false,
  canceling: false,
  session: {
    id: "live",
    harness: "codex",
    cwd: "/workspace",
    connection: "connected" as const,
    status: "ready" as const,
    modes: [],
    currentMode: null,
    configOptions: [],
    settings: {
      model: "a",
      options: { effort: "high", serviceTier: "default" },
    },
  },
}
replaceAcpConversation("live", observed)
acknowledgeComposerSettings(observed)
assert.equal(
  prefsStore.get().settingsOverrides[settingsTargetKey(target)],
  undefined
)
assert.equal(resolveComposerSettings(target).settings.options?.effort, "high")
chooseComposerOption(target, "serviceTier", "priority")
acknowledgeComposerSettings(observed)
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "priority"
)
resetComposerSettings(target)
assert.equal(
  resolveComposerSettings(target).settings.options?.serviceTier,
  "default"
)
acpStore.set({ conversations: {}, activeKey: null })
console.log(
  "Settings migration, live provenance, scoped edits, acknowledgements, and display/dispatch parity passed"
)
