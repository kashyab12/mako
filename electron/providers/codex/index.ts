import type { ProviderModule } from "../host.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"

export const installCodex: ProviderModule = (host) => {
  host.nativeRunners.register(codexNativeRunner)
  host.profiles.register(codexProfileLoader)
  host.mcpSources.register(codexMcpSource)
  host.skillSources.register(codexSkillSource)
}
