import type { NativeRunner } from "./native-runner.js"
import { ProviderRegistry } from "./registry.js"

export interface ProviderHost {
  nativeRunners: ProviderRegistry<NativeRunner>
}

export type ProviderModule = (host: ProviderHost) => void

export function createProviderHost(): ProviderHost {
  return { nativeRunners: new ProviderRegistry() }
}
