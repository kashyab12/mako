import { accountEnv } from "./accounts.js"
import { providerHost } from "./providers/index.js"
import {
  unavailableProviderProfile,
  unknownProviderProfile,
} from "./providers/profile-loader.js"
import type { HarnessProfile } from "./shared.js"
import { providerProfileCache } from "./provider-profile-cache.js"

export { resolveHarnessTuning } from "./harness-models.js"
export { normalizeAcpOptions } from "@mako/sessions/model-catalog"
export { devinExecutable } from "./providers/devin/executable.js"
export {
  openCodeExecutable,
  openCodeInstallation,
  openCodeSessionGeneration,
  type OpenCodeInstallation,
} from "./providers/opencode/installation.js"

const cache = new Map<string, { profile: HarnessProfile; loadedAt: number }>()
const loading = new Map<string, Promise<HarnessProfile>>()

export async function harnessProfile(
  harness: string,
  force = false,
  cwd?: string
): Promise<HarnessProfile> {
  const loader = providerHost.profiles.get(harness)
  if (!loader) return unknownProviderProfile(harness, "Unknown provider")
  const env = await accountEnv(harness, process.env)
  const key = `${harness}:${loader.cacheKey(env)}:${cwd ?? ""}`
  if (!force) {
    const held = cache.get(key)
    if (held && Date.now() - held.loadedAt < 30_000) return held.profile
  }
  const active = loading.get(key)
  if (active) return active
  const request = (async () => {
    let profile: HarnessProfile
    try {
      profile = await loader.load(env, cwd)
    } catch (error) {
      profile = unavailableProviderProfile(
        loader,
        error instanceof Error ? error.message : String(error)
      )
    }
    cache.set(key, { profile, loadedAt: Date.now() })
    await providerProfileCache.put(key, profile).catch(() => {})
    return profile
  })().finally(() => loading.delete(key))
  loading.set(key, request)
  return request
}

export async function harnessProfiles(
  force = false,
  cwd?: string
): Promise<HarnessProfile[]> {
  return Promise.all(
    providerHost.profiles
      .list()
      .map((loader) => harnessProfile(loader.provider, force, cwd))
  )
}
