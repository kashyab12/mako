import type { ProviderModule } from "../host.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProfileLoader } from "./profile.js"

export const installClaude: ProviderModule = (host) => {
  host.nativeRunners.register(claudeNativeRunner)
  host.profiles.register(claudeProfileLoader)
  host.mcpSources.register(claudeMcpSource)
}
