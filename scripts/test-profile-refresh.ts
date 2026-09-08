import assert from "node:assert/strict"
import type { HarnessProfile } from "../electron/shared.ts"
const requests: {
  provider: string
  cwd?: string
  resolve(value: HarnessProfile): void
}[] = []
Object.assign(globalThis, {
  window: {
    mako: {
      harnessTuning: (provider: string, cwd?: string) =>
        new Promise<HarnessProfile>((resolve) =>
          requests.push({ provider, cwd, resolve })
        ),
    },
  },
})
const { providers, providerStore, providerProfileKey } =
  await import("../src/state/providers.ts")
const profile: HarnessProfile = {
  id: "test",
  label: "Test",
  models: [],
  available: true,
  transport: "acp",
  capabilities: [],
  settings: { model: "old-account" },
}
const old = providers.load("test", false, "/work")
assert.equal(requests.length, 1)
const refresh = providers.refreshAccount("test")
assert.equal(requests.length, 2)
requests[1]!.resolve({ ...profile, settings: { model: "new-account" } })
await refresh
requests[0]!.resolve(profile)
await old
assert.equal(
  providerStore.get().contexts[providerProfileKey("test", "/work")]?.settings
    ?.model,
  "new-account"
)
await providers.load("test", false, "/work")
assert.equal(requests.length, 2, "fresh scoped config should be reused")
const another = providers.load("test", false, "/other")
assert.equal(requests.length, 3)
requests[2]!.resolve({ ...profile, settings: { model: "other-workspace" } })
await another
assert.equal(
  providerStore.get().contexts[providerProfileKey("test", "/work")]?.settings
    ?.model,
  "new-account"
)
console.log(
  "Profile refresh: account changes invalidate pending discovery; workspace settings remain isolated"
)
