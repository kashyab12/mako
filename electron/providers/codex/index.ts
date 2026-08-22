import { emitCodexSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { codexAccountCapability } from "./accounts.js"
import { codexMcpSource } from "./mcp.js"
import { codexNativeRunner } from "./native-runner.js"
import { codexProfileLoader } from "./profile.js"
import { codexSkillSource } from "./skills.js"

export const installCodex: ProviderModule = (host) => {
  host.accountCapabilities.register(codexAccountCapability)
  host.nativeRunners.register(codexNativeRunner)
  host.profiles.register(codexProfileLoader)
  host.mcpSources.register(codexMcpSource)
  host.skillSources.register(codexSkillSource)
  host.sessionEmitters.register({
    provider: "codex",
    emit: (thread) => emitCodexSession(thread, {}),
  })
}
