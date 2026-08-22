import type { ProviderModule } from "../host.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorNativeRunner } from "./native-runner.js"
import { cursorProfileLoader } from "./profile.js"

export const installCursor: ProviderModule = (host) => {
  host.nativeRunners.register(cursorNativeRunner)
  host.profiles.register(cursorProfileLoader)
  host.mcpSources.register(cursorMcpSource)
}
