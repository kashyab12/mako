import type { NativeRunner } from "./native-runner.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import { ProviderRegistry } from "./registry.js"

export interface ProviderHost {
  nativeRunners: ProviderRegistry<NativeRunner>
  profiles: ProviderRegistry<ProviderProfileLoader>
}

export type ProviderModule = (host: ProviderHost) => void

export function createProviderHost(): ProviderHost {
  return {
    nativeRunners: new ProviderRegistry(),
    profiles: new ProviderRegistry(),
  }
}
