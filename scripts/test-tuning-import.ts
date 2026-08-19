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

const { initializeComposerTuning, setComposerTuning, threadsStore } = await import(
  "../src/state/threads.ts"
)
const { prefsStore } = await import("../src/state/prefs.ts")

const initial = {
  id: "cursor",
  label: "Cursor",
  available: true,
  transport: "acp" as const,
  configuredModel: "model-a",
  defaultModel: "auto",
  capabilities: [],
  models: [
    {
      id: "model-a",
      label: "Model A",
      options: [
        {
          kind: "select" as const,
          id: "context",
          label: "Context",
          current: "1m",
          values: [
            { value: "200k", label: "200K" },
            { value: "1m", label: "1M" },
          ],
        },
        {
          kind: "select" as const,
          id: "reasoning",
          label: "Reasoning",
          current: "high",
          values: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
        },
        {
          kind: "select" as const,
          id: "fast",
          label: "Fast",
          current: "false",
          presentation: "toggle" as const,
          values: [
            { value: "false", label: "Off" },
            { value: "true", label: "On" },
          ],
        },
      ],
    },
    { id: "model-b", label: "Model B", options: [] },
  ],
}

initializeComposerTuning(initial)
assert.deepEqual(threadsStore.get().composerTuning.cursor, {
  model: "model-a",
  effort: "high",
  fast: false,
  options: { context: "1m", reasoning: "high", fast: "false" },
})
assert.deepEqual(prefsStore.get().providerTuningImported, ["cursor"])

initializeComposerTuning({
  ...initial,
  configuredModel: "model-b",
})
assert.equal(threadsStore.get().composerTuning.cursor?.model, "model-a")

setComposerTuning("cursor", {
  model: "model-b",
  effort: undefined,
  fast: undefined,
  options: {},
})
initializeComposerTuning(initial)
assert.deepEqual(threadsStore.get().composerTuning.cursor, {
  model: "model-b",
  effort: undefined,
  fast: undefined,
  options: {},
})
setComposerTuning("cursor", { model: "retired-but-owned-by-mako" })
initializeComposerTuning(initial)
assert.equal(
  threadsStore.get().composerTuning.cursor?.model,
  "retired-but-owned-by-mako"
)

initializeComposerTuning({
  id: "missing",
  label: "Missing",
  available: false,
  transport: "acp",
  capabilities: [],
  models: [],
})
assert.equal(prefsStore.get().providerTuningImported.includes("missing"), false)

initializeComposerTuning({
  id: "delayed",
  label: "Delayed",
  available: true,
  transport: "acp",
  defaultModel: "model-c",
  capabilities: [],
  models: [],
})
assert.equal(prefsStore.get().providerTuningImported.includes("delayed"), false)
initializeComposerTuning({
  id: "delayed",
  label: "Delayed",
  available: true,
  transport: "acp",
  defaultModel: "model-c",
  capabilities: [],
  models: [{ id: "model-c", label: "Model C", options: [] }],
})
assert.equal(threadsStore.get().composerTuning.delayed?.model, "model-c")
assert.equal(prefsStore.get().providerTuningImported.includes("delayed"), true)

setComposerTuning("legacy", { model: "mako-owned" })
initializeComposerTuning({
  id: "legacy",
  label: "Legacy",
  available: true,
  transport: "acp",
  configuredModel: "provider-owned",
  capabilities: [],
  models: [
    { id: "provider-owned", label: "Provider", options: [] },
    { id: "mako-owned", label: "Mako", options: [] },
  ],
})
assert.equal(threadsStore.get().composerTuning.legacy?.model, "mako-owned")
assert.equal(prefsStore.get().providerTuningImported.includes("legacy"), true)

console.log("Tuning import tests passed")
