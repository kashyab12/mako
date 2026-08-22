import type { HarnessProfile } from "../shared.js"
import type { ProviderCapability } from "./registry.js"

export interface ProviderProfileLoader extends ProviderCapability {
  cacheKey(env: NodeJS.ProcessEnv): string
  load(env: NodeJS.ProcessEnv): Promise<HarnessProfile>
}
