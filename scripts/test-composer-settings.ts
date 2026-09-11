import assert from "node:assert/strict"

// The renderer state layer is React-free, but modules read `window` at load.
Object.assign(globalThis, {
  window: {
    mako: {},
    addEventListener() {},
    removeEventListener() {},
    setInterval() {},
    clearInterval() {},
    location: { search: "" },
  },
})

const {
  composerModelLabel,
  currentSettingsTarget,
  resolveComposerSettingsInput,
  resolveSettingsTarget,
  threadSettingsTarget,
} = await import("../src/state/composer-settings.ts")
const { beginStart } = await import("../src/state/acp-start.ts")
const { acpStore } = await import("../src/state/acp-state.ts")
const { threadsStore } = await import("../src/state/thread-store.ts")
type HarnessProfile = import("../src/lib/types.ts").HarnessProfile
type ThreadRef = import("../src/lib/types.ts").ThreadRef

const cwd = "/repo"
const profile: HarnessProfile = {
  id: "claude",
  label: "Claude Code",
  available: true,
  transport: "acp",
  models: [{ id: "opus", label: "Opus 5", options: [] }],
  capabilities: [],
  settings: { model: "opus" },
}

function label(
  target: ReturnType<typeof resolveSettingsTarget>,
  session?: { model?: string },
  reporting = false
): string {
  const { resolved, model } = resolveComposerSettingsInput({
    target,
    profile,
    session,
  })
  return (
    model?.label ??
    (resolved.model.kind === "known" ? resolved.model.value : undefined) ??
    composerModelLabel({ target, profile, reporting })
  )
}

// A fresh composer shows the provider default before the send.
const fresh = resolveSettingsTarget({ harness: "claude", workspace: cwd })
assert.deepEqual(fresh, { kind: "new", harness: "claude", cwd })
assert.equal(label(fresh), "Opus 5")

// Sending creates a starting conversation. It carries the target the send
// resolved with, and the composer keeps resolving through that target, so the
// label cannot change between pressing Enter and the provider's first report.
threadsStore.set({ composerHarness: "claude" })
const starting = beginStart({
  harness: "claude",
  cwd,
  blocks: [{ type: "user", text: "hello" }],
  hiddenUserPrompt: null,
})
assert.equal(starting.settingsTarget.kind, "new")
assert.equal(acpStore.get().activeKey, starting.key)
assert.deepEqual(currentSettingsTarget("claude"), starting.settingsTarget)
const duringStart = resolveSettingsTarget({
  harness: "claude",
  live: {
    id: starting.key,
    harness: "claude",
    cwd,
    settingsTarget: starting.settingsTarget,
  },
  workspace: cwd,
})
assert.equal(duringStart, starting.settingsTarget)
assert.equal(label(duringStart), "Opus 5")

// Without that target the same conversation resolves as an existing session
// with no settings, which is the "Model unavailable" flicker this guards.
const asExisting = resolveSettingsTarget({
  harness: "claude",
  live: { id: starting.key, harness: "claude", cwd },
  workspace: cwd,
})
assert.equal(asExisting.kind, "live")
assert.equal(
  resolveComposerSettingsInput({ target: asExisting, profile, session: {} })
    .resolved.model.kind,
  "unknown"
)

// A stored target from another provider is never borrowed.
const foreign = resolveSettingsTarget({
  harness: "codex",
  live: {
    id: starting.key,
    harness: "claude",
    cwd,
    settingsTarget: starting.settingsTarget,
  },
  workspace: cwd,
})
assert.deepEqual(foreign, { kind: "new", harness: "codex", cwd })

// Resuming a thread keeps resolving through that thread's own settings.
const ref: ThreadRef = {
  harness: "claude",
  nativeId: "native-1",
  path: "/sessions/one.jsonl",
  cwd,
  model: "opus",
}
const resumed = beginStart({
  settingsTarget: threadSettingsTarget(ref),
  harness: "claude",
  cwd,
  threadPath: ref.path,
  blocks: [],
  hiddenUserPrompt: null,
})
const resuming = resolveSettingsTarget({
  harness: "claude",
  ref,
  live: {
    id: resumed.key,
    harness: "claude",
    cwd,
    path: ref.path,
    settingsTarget: resumed.settingsTarget,
  },
})
assert.deepEqual(resuming, threadSettingsTarget(ref))
assert.equal(label(resuming, { model: ref.model }), "Opus 5")

// The fallback copy names the actual state instead of blaming the provider.
const thread = threadSettingsTarget(ref)
assert.equal(
  composerModelLabel({ target: thread, profile, reporting: true }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({ target: thread, profile, reporting: false }),
  "Model not recorded"
)
assert.equal(
  composerModelLabel({ target: fresh, profile, reporting: false }),
  "Choose a model"
)
assert.equal(
  composerModelLabel({ target: thread, profile: undefined, reporting: false }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({
    target: thread,
    profile: { ...profile, available: false, pending: true, models: [] },
    reporting: false,
  }),
  "Loading model…"
)
assert.equal(
  composerModelLabel({
    target: thread,
    profile: { ...profile, available: false, models: [], error: "not installed" },
    reporting: true,
  }),
  "Model unavailable"
)
assert.equal(
  composerModelLabel({
    target: fresh,
    profile,
    error: "Model settings could not be loaded",
    reporting: true,
  }),
  "Model unavailable"
)

console.log("composer settings: starting conversations keep their send target")
