import type { ProviderModule } from "../host.js"
import { openCodeMcpSource } from "./mcp.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProfileLoader } from "./profile.js"
import { openCodeSkillSource } from "./skills.js"

export const installOpenCode: ProviderModule = (host) => {
  host.nativeRunners.register(openCodeNativeRunner)
  host.profiles.register(openCodeProfileLoader)
  host.mcpSources.register(openCodeMcpSource)
  host.skillSources.register(openCodeSkillSource)
}
