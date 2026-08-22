import type { HarnessModelCatalog } from "../harness-models.js"
import type { HarnessProfile } from "../shared.js"
import type { ProviderCapability } from "./registry.js"

export interface ProviderProfileLoader extends ProviderCapability {
  label: string
  transport: HarnessProfile["transport"]
  capabilities: string[]
  cacheKey(env: NodeJS.ProcessEnv): string
  load(env: NodeJS.ProcessEnv): Promise<HarnessProfile>
}

export function availableProviderProfile(
  loader: ProviderProfileLoader,
  catalog: HarnessModelCatalog
): HarnessProfile {
  const profile: HarnessProfile = {
    id: loader.provider,
    label: loader.label,
    available: true,
    transport: loader.transport,
    models: catalog.models,
    capabilities: loader.capabilities,
  }
  if (catalog.defaultModel) profile.defaultModel = catalog.defaultModel
  if (catalog.configuredModel) profile.configuredModel = catalog.configuredModel
  return profile
}

export function unavailableProviderProfile(
  loader: ProviderProfileLoader,
  error: string
): HarnessProfile {
  return {
    id: loader.provider,
    label: loader.label,
    available: false,
    transport: loader.transport,
    models: [],
    capabilities: loader.capabilities,
    error,
  }
}

export function unknownProviderProfile(
  provider: string,
  error: string
): HarnessProfile {
  return {
    id: provider,
    label: provider,
    available: false,
    transport: "remote",
    models: [],
    capabilities: [],
    error,
  }
}
