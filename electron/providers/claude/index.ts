import { emitClaudeSession } from "@mako/sessions"
import type { ProviderModule } from "../host.js"
import { claudeAcpSource } from "./acp.js"
import { claudeAccountCapability } from "./accounts.js"
import { claudeMcpSource } from "./mcp.js"
import { claudeNativeRunner } from "./native-runner.js"
import { claudeProcessProbe } from "./process-probe.js"
import { claudeProfileLoader } from "./profile.js"
import { claudeSkillSource } from "./skills.js"

export const installClaude: ProviderModule = (host) => {
  host.accountCapabilities.register(claudeAccountCapability)
  host.nativeRunners.register(claudeNativeRunner)
  host.acpSources.register(claudeAcpSource)
  host.profiles.register(claudeProfileLoader)
  host.processProbes.register(claudeProcessProbe)
  host.mcpSources.register(claudeMcpSource)
  host.skillSources.register(claudeSkillSource)
  host.sessionEmitters.register({
    provider: "claude",
    emit: (thread) => emitClaudeSession(thread, {}),
  })
}
