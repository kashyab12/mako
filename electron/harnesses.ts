import { accountEnv } from "./accounts.js"
import { providerHost } from "./providers/index.js"
import {
  unavailableProviderProfile,
  unknownProviderProfile,
} from "./providers/profile-loader.js"
import type { HarnessProfile } from "./shared.js"
import { providerProfileCache } from "./provider-profile-cache.js"

export { normalizeAcpOptions, resolveHarnessTuning } from "./harness-models.js"
export { devinExecutable } from "./providers/devin/executable.js"
export {
  openCodeExecutable,
  openCodeInstallation,
  openCodeSessionGeneration,
  type OpenCodeInstallation,
} from "./providers/opencode/installation.js"

const cache = new Map<string, HarnessProfile>()
const loading = new Map<string, Promise<HarnessProfile>>()

export async function harnessProfile(
  harness: string,
  force = false
): Promise<HarnessProfile> {
  const loader = providerHost.profiles.get(harness)
  if (!loader) return unknownProviderProfile(harness, "Unknown provider")
  const env = await accountEnv(harness, process.env)
  const key = `${harness}:${loader.cacheKey(env)}`
  if (!force) {
    const held = cache.get(key)
    if (held) return held
    const persisted = await providerProfileCache.get(key)
    if (persisted?.id === harness) {
      cache.set(key, persisted)
      return persisted
    }
  }
  const active = loading.get(key)
  if (active) return active
  const request = (async () => {
    let profile: HarnessProfile
    try {
      profile = await loader.load(env)
    } catch (error) {
      profile = unavailableProviderProfile(
        loader,
        error instanceof Error ? error.message : String(error)
      )
    }
    cache.set(key, profile)
    await providerProfileCache.put(key, profile).catch(() => {})
    return profile
  })().finally(() => loading.delete(key))
  loading.set(key, request)
  return request
}

export async function harnessProfiles(force = false): Promise<HarnessProfile[]> {
  return Promise.all(
    providerHost.profiles
      .list()
      .map((loader) => harnessProfile(loader.provider, force))
  )
}
