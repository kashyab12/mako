import type { ProviderModule } from "../host.js"
import { grokMcpSource } from "./mcp.js"
import { grokNativeRunner } from "./native-runner.js"
import { grokProfileLoader } from "./profile.js"

export const installGrok: ProviderModule = (host) => {
  host.nativeRunners.register(grokNativeRunner)
  host.profiles.register(grokProfileLoader)
  host.mcpSources.register(grokMcpSource)
}
