import assert from "node:assert/strict"
import { mock } from "node:test"
import { providerHost } from "../electron/providers/index.js"
import { providerProfileCache } from "../electron/provider-profile-cache.js"
import {
  harnessProfile,
  harnessProfileForSend,
  harnessProfilesNow,
  resolveHarnessLaunch,
  onHarnessProfile,
} from "../electron/harnesses.js"
import type { HarnessProfile } from "../electron/shared.js"

let account = "one"
let loads = 0
const profile: HarnessProfile = {
  id: "queue-profile-test",
  label: "Test",
  available: true,
  transport: "sdk",
  models: [],
  capabilities: [],
}
providerHost.profiles.register({
  provider: profile.id,
  label: "Test",
  transport: "sdk",
  capabilities: [],
  cacheKey: () => account,
  load: async () => {
    loads++
    return profile
  },
})
const persist = mock.method(providerProfileCache, "put", async () => {})
const recall = mock.method(providerProfileCache, "get", async () => null)
const originalTime = Date.now()
let now = originalTime
const clock = mock.method(Date, "now", () => now)
const reported: (string | undefined)[] = []
const stopReporting = onHarnessProfile((event) => {
  if (event.profile.id === profile.id) reported.push(event.cwd)
})
// Only the fixture provider: the installed CLIs must never run under a test.
const only = mock.method(providerHost.profiles, "list", () => [
  providerHost.profiles.get(profile.id)!,
])
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
try {
  assert.equal(await resolveHarnessLaunch(profile.id, "/one", undefined), undefined)
  const nativeOptions = { options: { effort: "high" } }
  assert.equal(await resolveHarnessLaunch(profile.id, "/one", nativeOptions), nativeOptions)
  assert.equal(loads, 0, "Native defaults and model-free options cannot wait for model discovery")
  const cacheGate = Promise.withResolvers<null>()
  recall.mock.mockImplementationOnce(() => cacheGate.promise)
  let answered = false
  const immediate = harnessProfilesNow("/one").then((profiles) => { answered = true; return profiles })
  await settle()
  cacheGate.resolve(null)
  assert.equal(answered, true, "Provider names cannot wait for cache, account, or model discovery")
  const pending = await immediate
  assert.ok(
    pending.some((entry) => entry.id === profile.id && entry.pending),
    "An unknown provider answers as pending instead of blocking the list"
  )
  await settle()
  assert.equal(loads, 1)
  assert.deepEqual(reported, ["/one"], "Discovery reports through the event")
  now += 60_000
  await harnessProfileForSend(profile.id, "/one")
  assert.equal(
    loads,
    1,
    "Sending does not run discovery again after the display TTL"
  )
  const stale = await harnessProfile(profile.id, false, "/one")
  assert.equal(stale.pending, undefined, "An expired profile is served, not withheld")
  assert.equal(loads, 2, "Ordinary discovery still refreshes expired profiles")
  await settle()
  assert.equal(reported.length, 2, "The refresh behind a stale answer reports")
  await harnessProfile(profile.id, true, "/one")
  assert.equal(loads, 3, "Explicit refresh stays authoritative")
  await harnessProfileForSend(profile.id, "/two")
  assert.equal(
    loads,
    4,
    "A different workspace cannot borrow the cached settings"
  )
  account = "two"
  await harnessProfileForSend(profile.id, "/one")
  assert.equal(
    loads,
    5,
    "A different account cannot borrow the cached settings"
  )
  console.log(
    "Send discovery: instant answers with discovery behind them; warm sends avoid CLI refresh; explicit refresh, workspace and account isolation passed"
  )
} finally {
  stopReporting()
  only.mock.restore()
  clock.mock.restore()
  persist.mock.restore()
  recall.mock.restore()
}
