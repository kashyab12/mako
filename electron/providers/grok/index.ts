import type { ProviderModule } from "../host.js"
import { grokAcpSource } from "./acp.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProfileLoader } from "./profile.js"
import { grokSkillSource } from "./skills.js"

export const installGrok: ProviderModule = (host) => {
  host.nativeRunners.register(grokNativeRunner)
  host.acpSources.register(grokAcpSource)
  host.profiles.register(grokProfileLoader)
  host.mcpSources.register(grokMcpSource)
  host.skillSources.register(grokSkillSource)
}
