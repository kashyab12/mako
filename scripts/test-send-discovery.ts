import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      "Discovery did not reach the expected phase"
    )
    await settle()
  }
}
try {
  assert.equal(
    await resolveHarnessLaunch(profile.id, "/one", undefined),
    undefined
  )
  const nativeOptions = { options: { effort: "high" } }
  assert.equal(
    await resolveHarnessLaunch(profile.id, "/one", nativeOptions),
    nativeOptions
  )
  assert.equal(
    loads,
    0,
    "Native defaults and model-free options cannot wait for model discovery"
  )
  const cacheGate = Promise.withResolvers<null>()
  recall.mock.mockImplementationOnce(() => cacheGate.promise)
  let answered = false
  const immediate = harnessProfilesNow("/one").then((profiles) => {
    answered = true
    return profiles
  })
  await settle()
  cacheGate.resolve(null)
  assert.equal(
    answered,
    true,
    "Provider names cannot wait for cache, account, or model discovery"
  )
  const pending = await immediate
  assert.ok(
    pending.some((entry) => entry.id === profile.id && entry.pending),
    "An unknown provider answers as pending instead of blocking the list"
  )
  await until(() => reported.length >= 1)
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
  assert.equal(
    stale.pending,
    undefined,
    "An expired profile is served, not withheld"
  )
  assert.equal(loads, 2, "Ordinary discovery still refreshes expired profiles")
  await until(() => reported.length >= 2)
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
  const loader = providerHost.profiles.get(profile.id)
  assert.ok(loader)
  const launchGate = Promise.withResolvers<void>()
  let launchLoads = 0
  const launchProfile: HarnessProfile = {
    ...profile,
    models: [
      {
        id: "fixture-model",
        label: "Fixture",
        options: [
          {
            kind: "select",
            id: "effort",
            label: "Effort",
            values: [{ value: "low", label: "Low" }],
          },
        ],
      },
    ],
  }
  loader.loadForSend = async () => {
    launchLoads++
    await launchGate.promise
    return launchProfile
  }
  account = "launch-one"
  const beforeReports = reported.length
  const first = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
    options: { effort: "low" },
  })
  const duplicate = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 1)
  assert.equal(
    launchLoads,
    1,
    "Concurrent launches share a scoped catalogue query"
  )
  account = "launch-two"
  const otherAccount = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
  })
  const otherWorkspace = resolveHarnessLaunch(profile.id, "/two", {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 3)
  assert.equal(
    launchLoads,
    3,
    "Launch catalogues stay isolated by account and workspace"
  )
  launchGate.resolve()
  await Promise.all([first, duplicate, otherAccount, otherWorkspace])
  assert.equal(
    reported.length,
    beforeReports,
    "Launch-only data must not replace the full displayed profile"
  )
  await assert.rejects(
    resolveHarnessLaunch(profile.id, "/one", {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  const root = await mkdtemp(join(tmpdir(), "mako-profile-alias-"))
  try {
    const directory = join(root, "workspace")
    const alias = join(root, "alias")
    await mkdir(directory)
    await symlink(directory, alias, "junction")
    account = "aliased-workspace"
    await harnessProfile(profile.id, true, directory)
    const before = launchLoads
    assert.equal(await harnessProfileForSend(profile.id, alias), profile)
    assert.equal(
      launchLoads,
      before,
      "A workspace alias reuses the validated profile rather than starting another CLI"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  loader.nativeModelIds = true
  const beforeNativeSelection = launchLoads
  const nativeSelection = { model: "provider-native-id", options: {} }
  assert.equal(
    await resolveHarnessLaunch(
      profile.id,
      "/native-selection",
      nativeSelection
    ),
    nativeSelection
  )
  assert.equal(
    launchLoads,
    beforeNativeSelection,
    "Provider-native model-only selections need no catalogue translation"
  )
  await assert.rejects(
    resolveHarnessLaunch(profile.id, "/native-selection", {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  const unavailable = { ...profile, available: false, error: "Provider is not signed in", models: [] }
  loader.loadForSend = async () => unavailable
  account = "unavailable-model-catalogue"
  await assert.rejects(resolveHarnessLaunch(profile.id, "/unavailable", { model: "model-family", options: { effort: "high" } }), /not signed in/)
  console.log(
    "Send discovery: native defaults and native IDs avoid discovery; option validation, concurrent launches, account/workspace isolation, aliases, and full profile updates are preserved"
  )
} finally {
  stopReporting()
  only.mock.restore()
  clock.mock.restore()
  persist.mock.restore()
  recall.mock.restore()
}
