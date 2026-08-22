import { accountEnv } from "./accounts.js"
import { unavailableHarnessProfile } from "./harness-models.js"
import { providerHost } from "./providers/index.js"
import type { HarnessProfile } from "./shared.js"

export { normalizeAcpOptions, resolveHarnessTuning } from "./harness-models.js"
export { devinExecutable } from "./providers/devin/executable.js"
export {
  openCodeExecutable,
  openCodeInstallation,
  openCodeSessionGeneration,
  type OpenCodeInstallation,
} from "./providers/opencode/installation.js"

const cache = new Map<string, { at: number; profile: HarnessProfile }>()

export async function harnessProfile(harness: string): Promise<HarnessProfile> {
  const loader = providerHost.profiles.get(harness)
  if (!loader) return unavailableHarnessProfile(harness, "Unknown provider")
  const env = await accountEnv(harness, process.env)
  const key = `${harness}:${loader.cacheKey(env)}`
  const now = Date.now()
  for (const [cachedKey, cached] of cache) {
    if (now - cached.at >= 30_000) cache.delete(cachedKey)
  }
  const held = cache.get(key)
  if (held) return held.profile
  let profile: HarnessProfile
  try {
    profile = await loader.load(env)
  } catch (error) {
    profile = unavailableHarnessProfile(
      harness,
      error instanceof Error ? error.message : String(error)
    )
  }
  cache.set(key, { at: Date.now(), profile })
  return profile
}

export async function harnessProfiles(): Promise<HarnessProfile[]> {
  return Promise.all(
    providerHost.profiles.list().map((loader) => harnessProfile(loader.provider))
  )
}
