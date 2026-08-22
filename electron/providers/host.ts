import type { ProviderMcpSource } from "./mcp-source.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderSkillSource } from "./skill-source.js"
import { ProviderRegistry } from "./registry.js"

export interface ProviderHost {
  nativeRunners: ProviderRegistry<NativeRunner>
  profiles: ProviderRegistry<ProviderProfileLoader>
  mcpSources: ProviderRegistry<ProviderMcpSource>
  skillSources: ProviderRegistry<ProviderSkillSource>
}

export type ProviderModule = (host: ProviderHost) => void

export function createProviderHost(): ProviderHost {
  return {
    nativeRunners: new ProviderRegistry(),
    profiles: new ProviderRegistry(),
    mcpSources: new ProviderRegistry(),
    skillSources: new ProviderRegistry(),
  }
}
